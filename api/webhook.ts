// ============================================================================
// SUMA — Main WhatsApp Webhook Handler
// Vercel Serverless Function (Node.js runtime)
//
// Handles:
//   GET  /api/webhook → WhatsApp verification challenge
//   POST /api/webhook → Incoming messages
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { WhatsAppWebhookBody, WhatsAppMessage, MediaContent } from "../src/types/index.js";
import { loadConfig } from "../src/utils/config.js";
import { parseExpense } from "../src/services/expense-parser.js";
import { downloadWhatsAppMedia } from "../src/services/whatsapp-media.js";
import {
  insertExpense,
  upsertUser,
  resolveCategoryId,
} from "../src/services/expense-repository.js";
import {
  sendWhatsAppMessage,
  formatSuccessMessage,
  formatHelpMessage,
} from "../src/services/whatsapp.js";

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
    res.status(200).json({ status: "received" });
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
  const userPhone = msg.from.replace(/^549/, '54');

  // ── Text messages (existing flow) ────────────────────────────────────
  if (msg.type === "text") {
    const text = msg.text?.body;
    if (!text) return;

    console.log(`[SUMA] 📩 Message from ${userPhone}: "${text}"`);

    const parsed = await parseExpense(text, config.GEMINI_API_KEY);

    if (!parsed) {
      await sendWhatsAppMessage({
        to: userPhone,
        text: formatHelpMessage(),
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
        apiToken: config.WHATSAPP_API_TOKEN,
      });
      return;
    }

    await saveAndConfirmExpense(userPhone, parsed, text, config);
    return;
  }

  // ── Audio messages (voice notes) ─────────────────────────────────────
  if (msg.type === "audio" && msg.audio) {
    console.log(`[SUMA] 🎵 Audio from ${userPhone} (${msg.audio.mime_type})`);

    let media: MediaContent;
    try {
      media = await downloadWhatsAppMedia(msg.audio.id, config.WHATSAPP_API_TOKEN);
    } catch (err) {
      console.error("[SUMA] ❌ Audio download failed:", err);
      await sendWhatsAppMessage({
        to: userPhone,
        text: "❌ No pude descargar el audio. Por favor intentá de nuevo.",
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
        apiToken: config.WHATSAPP_API_TOKEN,
      });
      return;
    }

    const parsed = await parseExpense("", config.GEMINI_API_KEY, media);

    if (!parsed) {
      await sendWhatsAppMessage({
        to: userPhone,
        text: "🤔 No pude extraer un gasto del audio. Probá dictándolo más claro, por ejemplo: _\"Gasté 5000 en pizza\"_",
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
        apiToken: config.WHATSAPP_API_TOKEN,
      });
      return;
    }

    await saveAndConfirmExpense(userPhone, parsed, "[audio]", config);
    return;
  }

  // ── Image messages (receipt photos) ──────────────────────────────────
  if (msg.type === "image" && msg.image) {
    const caption = msg.image.caption ?? "";
    console.log(`[SUMA] 📷 Image from ${userPhone} (${msg.image.mime_type})${caption ? ` caption: "${caption}"` : ""}`);

    let media: MediaContent;
    try {
      media = await downloadWhatsAppMedia(msg.image.id, config.WHATSAPP_API_TOKEN);
    } catch (err) {
      console.error("[SUMA] ❌ Image download failed:", err);
      await sendWhatsAppMessage({
        to: userPhone,
        text: "❌ No pude descargar la imagen. Por favor intentá de nuevo.",
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
        apiToken: config.WHATSAPP_API_TOKEN,
      });
      return;
    }

    const parsed = await parseExpense(caption, config.GEMINI_API_KEY, media);

    if (!parsed) {
      await sendWhatsAppMessage({
        to: userPhone,
        text: "🤔 No pude extraer un gasto de la imagen. Asegurate de que sea un ticket legible.",
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
        apiToken: config.WHATSAPP_API_TOKEN,
      });
      return;
    }

    const rawMessage = caption ? `[imagen] ${caption}` : "[imagen]";
    await saveAndConfirmExpense(userPhone, parsed, rawMessage, config);
    return;
  }

  // ── Unsupported message types → silently ignore ──────────────────────
  console.log(`[SUMA] ⏭️ Ignoring message type: ${msg.type} from ${userPhone}`);
}

// ---------------------------------------------------------------------------
// Save expense and send confirmation
// ---------------------------------------------------------------------------

import type { ParsedExpense } from "../src/types/index.js";

async function saveAndConfirmExpense(
  userPhone: string,
  parsed: ParsedExpense,
  rawMessage: string,
  config: AppConfig
): Promise<void> {
  const [userId, categoryId] = await Promise.all([
    upsertUser(userPhone),
    resolveCategoryId(parsed.category),
  ]);

  await insertExpense({
    user_id: userId,
    amount: parsed.amount,
    description: parsed.description,
    category_id: categoryId,
    raw_message: rawMessage,
  });

  console.log(
    `[SUMA] 💾 Expense saved: $${parsed.amount} — ${parsed.description} [${parsed.category}]`
  );

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