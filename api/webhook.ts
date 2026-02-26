// ============================================================================
// SUMA — Thin Webhook Handler (api/webhook.ts)
//
// This endpoint does THREE things and nothing more:
//   1. GET  → WhatsApp verification challenge (handshake)
//   2. POST → Validate HMAC signature → Enqueue messages in QStash → Return 200
//
// All heavy processing happens in api/process-message.ts (async worker).
// This guarantees we respond to Meta within ~200ms, preventing retries.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import type {
  WhatsAppWebhookBody,
  QueuedMessagePayload,
} from "../src/types/index.js";
import { loadConfig } from "../src/utils/config.js";
import { validateWebhookSignature } from "../src/lib/hmac.js";
import { publishToQStash } from "../src/queue/qstash.js";
import type { IncomingMessage } from "node:http";

/** Reads the entire request body as a raw string from the stream */
function getRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// GET — Webhook verification (Meta challenge-response handshake)
// ---------------------------------------------------------------------------

function handleVerification(req: VercelRequest, res: VercelResponse): void {
  const config = loadConfig();

  const mode = req.query["hub.mode"] as string | undefined;
  const token = req.query["hub.verify_token"] as string | undefined;
  const challenge = req.query["hub.challenge"] as string | undefined;

  if (mode === "subscribe" && token === config.WHATSAPP_VERIFY_TOKEN) {
    console.log("[SUMA] ✅ Webhook verified successfully");
    res.status(200).send(challenge);
    return;
  }

  console.warn("[SUMA] ⚠️ Verification failed — invalid token");
  res.status(403).json({ error: "Forbidden" });
}

// ---------------------------------------------------------------------------
// POST — Validate signature → extract messages → enqueue → return 200
// ---------------------------------------------------------------------------

async function handleIncomingWebhook(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const config = loadConfig();

  // ── Step 1: Validate HMAC signature ─────────────────────────────────
  const rawBody = await getRawBody(req);
  const signature = req.headers["x-hub-signature-256"] as string | undefined;

  if (!validateWebhookSignature(rawBody, signature, config.WHATSAPP_APP_SECRET)) {
    console.error("[SUMA] ❌ Invalid webhook signature — rejecting");
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // ── Step 2: Parse and extract messages ──────────────────────────────
  const body: WhatsAppWebhookBody = JSON.parse(rawBody);

  if (body.object !== "whatsapp_business_account") {
    res.status(200).json({ status: "ignored" });
    return;
  }

  const items = extractMessageItems(body);

  if (items.length === 0) {
    res.status(200).json({ status: "no_messages" });
    return;
  }

  // ── Step 3: Enqueue in QStash THEN return 200 ──────────────────────
  // QStash publish is fast (~50ms), safe to do before responding.
  // Vercel Hobby kills the function immediately after res.send().
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";
  const targetUrl = `${baseUrl}/api/process-message`;

  const enqueueResults = await Promise.allSettled(
    items.map(async (item) => {
      const result = await publishToQStash({
        qstashToken: config.QSTASH_TOKEN,
        targetUrl,
        payload: item,
      });
      console.log(
        `[SUMA] 📤 Queued ${item.message.id} → QStash ${result.messageId}`
      );
      return result;
    })
  );

  const failed = enqueueResults.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length > 0) {
    console.error(
      `[SUMA] ❌ Failed to queue ${failed.length}/${items.length} messages`,
      failed.map((r) => r.reason)
    );
  }

  res.status(200).json({ status: "queued", count: items.length });
}

// ---------------------------------------------------------------------------
// Extract individual message payloads from the webhook body
// ---------------------------------------------------------------------------

interface MessageItem extends QueuedMessagePayload { }

function extractMessageItems(body: WhatsAppWebhookBody): MessageItem[] {
  const items: MessageItem[] = [];
  const now = new Date().toISOString();

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // Ignore status updates (delivered, read, etc.)
      if (change.field !== "messages") continue;

      const messages = change.value?.messages;
      if (!messages?.length) continue;

      for (const message of messages) {
        items.push({
          message,
          contacts: change.value.contacts,
          metadata: {
            phone_number_id: change.value.metadata.phone_number_id,
            display_phone_number: change.value.metadata.display_phone_number,
          },
          receivedAt: now,
        });
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  switch (req.method) {
    case "GET":
      return handleVerification(req, res);
    case "POST":
      return handleIncomingWebhook(req, res);
    default:
      res.status(405).json({ error: "Method not allowed" });
  }
}

// Disable Vercel's automatic body parser so we get the raw body
// for HMAC signature validation (byte-for-byte match required)
export const config = {
  api: { bodyParser: false },
};
