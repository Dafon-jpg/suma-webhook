// ============================================================================
// SUMA — Main WhatsApp Webhook Handler
// Vercel Serverless Function (Node.js runtime)
//
// Handles:
//   GET  /api/webhook → WhatsApp verification challenge
//   POST /api/webhook → Incoming messages
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { WhatsAppWebhookBody, WhatsAppMessage } from "../src/types";
import { loadConfig } from "../src/utils/config";
import { parseExpense } from "../src/services/expense-parser";
import {
  insertExpense,
  upsertUser,
  resolveCategoryId,
} from "../src/services/expense-repository";
import {
  sendWhatsAppMessage,
  formatSuccessMessage,
  formatHelpMessage,
} from "../src/services/whatsapp";

// ---------------------------------------------------------------------------
// GET — Webhook verification (WhatsApp challenge-response)
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

  console.warn("[SUMA] ⚠️ Webhook verification failed — invalid token");
  res.status(403).json({ error: "Forbidden: invalid verify token" });
}

// ---------------------------------------------------------------------------
// POST — Process incoming WhatsApp messages
// ---------------------------------------------------------------------------

async function handleIncomingMessage(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const config = loadConfig();

  // Respond 200 immediately — WhatsApp retries on timeouts
  res.status(200).json({ status: "received" });

  try {
    const body = req.body as WhatsAppWebhookBody;

    // Guard: only process WhatsApp messages
    if (body.object !== "whatsapp_business_account") return;

    // Extract messages from the webhook payload
    const messages = extractMessages(body);
    if (messages.length === 0) return;

    // Process each message
    for (const msg of messages) {
      await processMessage(msg, config);
    }
  } catch (err) {
    // Log but don't throw — we already sent 200
    console.error("[SUMA] ❌ Error processing webhook:", err);
  }
}

// ---------------------------------------------------------------------------
// Message processing pipeline
// ---------------------------------------------------------------------------

interface AppConfig {
  WHATSAPP_API_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  GEMINI_API_KEY?: string;
}

async function processMessage(
  msg: WhatsAppMessage,
  config: AppConfig
): Promise<void> {
  const userPhone = msg.from;
  const text = msg.text?.body;

  // Only handle text messages
  if (msg.type !== "text" || !text) return;

  console.log(`[SUMA] 📩 Message from ${userPhone}: "${text}"`);

  // Try to parse the expense
  const parsed = await parseExpense(text, config.GEMINI_API_KEY);

  if (!parsed) {
    // Could not parse — send help message
    await sendWhatsAppMessage({
      to: userPhone,
      text: formatHelpMessage(),
      phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
      apiToken: config.WHATSAPP_API_TOKEN,
    });
    return;
  }

  // Resolve user and category in parallel
  const [userId, categoryId] = await Promise.all([
    upsertUser(userPhone),
    resolveCategoryId(parsed.category),
  ]);

  // Save expense
  await insertExpense({
    user_id: userId,
    amount: parsed.amount,
    description: parsed.description,
    category_id: categoryId,
    raw_message: text,
  });

  console.log(
    `[SUMA] 💾 Expense saved: $${parsed.amount} — ${parsed.description} [${parsed.category}]`
  );

  // Confirm to user
  await sendWhatsAppMessage({
    to: userPhone,
    text: formatSuccessMessage(parsed.amount, parsed.description, parsed.category),
    phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
    apiToken: config.WHATSAPP_API_TOKEN,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractMessages(body: WhatsAppWebhookBody): WhatsAppMessage[] {
  const messages: WhatsAppMessage[] = [];

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const msgs = change.value?.messages;
      if (msgs) messages.push(...msgs);
    }
  }

  return messages;
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
      return handleIncomingMessage(req, res);
    default:
      res.status(405).json({ error: "Method not allowed" });
  }
}
