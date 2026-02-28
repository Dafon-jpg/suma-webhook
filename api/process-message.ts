// ============================================================================
// SUMA — Message Processing Worker (api/process-message.ts)
//
// This endpoint is called by QStash (not directly by Meta).
// It processes a single WhatsApp message through the full pipeline:
//   1. Verify QStash signature
//   2. Check idempotency (skip if already processed)
//   3. Run the processing pipeline (parse, save, confirm)
//   4. Return 200 on success (or 5xx for QStash to retry)
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import type {
    QueuedMessagePayload,
    WhatsAppMessage,
    ParsedExpense,
} from "../src/types/index.js";
import { loadConfig } from "../src/utils/config.js";
import { verifyQStashSignature } from "../src/queue/qstash.js";
import {
    claimMessageId,
    markMessageProcessed,
    markMessageError,
} from "../src/services/idempotency.js";
import { parseExpense } from "../src/services/expense-parser.js";
import { downloadWhatsAppMedia } from "../src/services/whatsapp-media.js";
import {
    upsertUser,
    saveExpenseAsTransaction,
} from "../src/services/transaction-repository.js";
import {
    sendWhatsAppMessage,
    formatSuccessMessage,
    formatHelpMessage,
} from "../src/services/whatsapp.js";

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(
    req: VercelRequest,
    res: VercelResponse
): Promise<void> {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    const config = loadConfig();

    // ── Step 1: Verify this request actually came from QStash ───────────
    const signature = req.headers["upstash-signature"] as string | undefined;
    const rawBody = typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body);

    if (!signature) {
        res.status(401).json({ error: "Missing QStash signature" });
        return;
    }

    const isValid = await verifyQStashSignature(
        signature,
        rawBody,
        config.QSTASH_CURRENT_SIGNING_KEY,
        config.QSTASH_NEXT_SIGNING_KEY
    );

    if (!isValid) {
        console.error("[SUMA] ❌ Invalid QStash signature — rejecting");
        res.status(401).json({ error: "Invalid signature" });
        return;
    }

    // ── Step 2: Parse the payload ───────────────────────────────────────
    const payload: QueuedMessagePayload =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const { message: msg } = payload;
    const userPhone = msg.from.replace(/^549/, "54");

    // ── Step 3: Idempotency check ──────────────────────────────────────
    const claimed = await claimMessageId(msg.id, userPhone);
    if (!claimed) {
        // Already processed — return 200 so QStash doesn't retry
        res.status(200).json({ status: "duplicate", wamid: msg.id });
        return;
    }

    // ── Step 4: Process the message ────────────────────────────────────
    try {
        await processMessage(msg, userPhone, payload, config);
        await markMessageProcessed(msg.id);

        res.status(200).json({ status: "processed", wamid: msg.id });
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[SUMA] ❌ Processing failed for ${msg.id}:`, errorMsg);

        await markMessageError(msg.id, errorMsg);

        // Return 500 so QStash retries this message
        res.status(500).json({ error: "Processing failed", wamid: msg.id });
    }
}

// ---------------------------------------------------------------------------
// Message processing pipeline (extracted for clarity)
// ---------------------------------------------------------------------------

async function processMessage(
    msg: WhatsAppMessage,
    userPhone: string,
    _payload: QueuedMessagePayload,
    config: ReturnType<typeof loadConfig>
): Promise<void> {
    const sendParams = {
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
        apiToken: config.WHATSAPP_API_TOKEN,
    };

    // ── Text messages ───────────────────────────────────────────────────
    if (msg.type === "text") {
        const text = msg.text?.body;
        if (!text) return;

        console.log(`[SUMA] 📩 Processing text from ${userPhone}: "${text}"`);

        const parsed = await parseExpense(text, config.GEMINI_API_KEY);
        if (!parsed) {
            await sendWhatsAppMessage({
                to: userPhone,
                text: formatHelpMessage(),
                ...sendParams,
            });
            return;
        }

        await saveAndConfirm(userPhone, parsed, text, sendParams);
        return;
    }

    // ── Audio messages (voice notes) ────────────────────────────────────
    if (msg.type === "audio" && msg.audio) {
        console.log(`[SUMA] 🎵 Processing audio from ${userPhone}`);

        const media = await downloadWhatsAppMedia(
            msg.audio.id,
            config.WHATSAPP_API_TOKEN
        );

        const parsed = await parseExpense("", config.GEMINI_API_KEY, media);
        if (!parsed) {
            await sendWhatsAppMessage({
                to: userPhone,
                text: "🤔 No pude extraer un gasto del audio. Probá dictándolo más claro, por ejemplo: _\"Gasté 5000 en pizza\"_",
                ...sendParams,
            });
            return;
        }

        await saveAndConfirm(userPhone, parsed, "[audio]", sendParams);
        return;
    }

    // ── Image messages (receipt photos) ─────────────────────────────────
    if (msg.type === "image" && msg.image) {
        const caption = msg.image.caption ?? "";
        console.log(`[SUMA] 📷 Processing image from ${userPhone}`);

        const media = await downloadWhatsAppMedia(
            msg.image.id,
            config.WHATSAPP_API_TOKEN
        );

        const parsed = await parseExpense(caption, config.GEMINI_API_KEY, media);
        if (!parsed) {
            await sendWhatsAppMessage({
                to: userPhone,
                text: "🤔 No pude extraer un gasto de la imagen. Asegurate de que sea un ticket legible.",
                ...sendParams,
            });
            return;
        }

        const rawMessage = caption ? `[imagen] ${caption}` : "[imagen]";
        await saveAndConfirm(userPhone, parsed, rawMessage, sendParams);
        return;
    }

    // ── Unsupported types → silent skip ─────────────────────────────────
    console.log(`[SUMA] ⏭️ Ignoring message type: ${msg.type} from ${userPhone}`);
}

// ---------------------------------------------------------------------------
// Save expense and send WhatsApp confirmation
// ---------------------------------------------------------------------------

interface SendParams {
    phoneNumberId: string;
    apiToken: string;
}

async function saveAndConfirm(
    userPhone: string,
    parsed: ParsedExpense,
    rawMessage: string,
    sendParams: SendParams
): Promise<void> {
    const userInfo = await upsertUser(userPhone);

    await saveExpenseAsTransaction({
        userId: userInfo.id,
        parsed,
        rawMessage,
    });

    console.log(
        `[SUMA] 💾 Transaction saved: $${parsed.amount} — ${parsed.description} [${parsed.category}]`
    );

    await sendWhatsAppMessage({
        to: userPhone,
        text: formatSuccessMessage(parsed.amount, parsed.description, parsed.category),
        ...sendParams,
    });
}