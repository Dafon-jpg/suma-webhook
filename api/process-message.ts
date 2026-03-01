// ============================================================================
// SUMA — Message Processing Worker (api/process-message.ts)
//
// Sección 3: Intent-based routing.
//
// This endpoint is called by QStash (not directly by Meta).
// It processes a single WhatsApp message through the full pipeline:
//   1. Verify QStash signature
//   2. Check idempotency (skip if already processed)
//   3. Parse message → classify intent via transaction-parser
//   4. Route by intent: record | query | system_command | unknown
//   5. Return 200 on success (or 5xx for QStash to retry)
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import type {
    QueuedMessagePayload,
    WhatsAppMessage,
    MediaContent,
    ParsedIntent,
    ParsedTransactionData,
} from "../src/types/index.js";
import { loadConfig } from "../src/utils/config.js";
import { verifyQStashSignature } from "../src/queue/qstash.js";
import {
    claimMessageId,
    markMessageProcessed,
    markMessageError,
} from "../src/services/idempotency.js";
import { parseTransaction } from "../src/services/transaction-parser.js";
import { downloadWhatsAppMedia } from "../src/services/whatsapp-media.js";
import {
    upsertUser,
    insertTransaction,
    resolveCategoryId,
    ensureDefaultAccount,
} from "../src/services/transaction-repository.js";
import {
    sendWhatsAppMessage,
    formatTransactionSuccess,
    formatHelpMessage,
} from "../src/services/whatsapp.js";

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(
    req: VercelRequest,
    res: VercelResponse,
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
        config.QSTASH_NEXT_SIGNING_KEY,
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
        res.status(200).json({ status: "duplicate", wamid: msg.id });
        return;
    }

    // ── Step 4: Process the message ────────────────────────────────────
    try {
        await processMessage(msg, userPhone, config);
        await markMessageProcessed(msg.id);
        res.status(200).json({ status: "processed", wamid: msg.id });
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[SUMA] ❌ Processing failed for ${msg.id}:`, errorMsg);
        await markMessageError(msg.id, errorMsg);
        res.status(500).json({ error: "Processing failed", wamid: msg.id });
    }
}

// ---------------------------------------------------------------------------
// WhatsApp send params helper
// ---------------------------------------------------------------------------

interface SendParams {
    phoneNumberId: string;
    apiToken: string;
}

// ---------------------------------------------------------------------------
// Message processing pipeline — intent-based routing
// ---------------------------------------------------------------------------

async function processMessage(
    msg: WhatsAppMessage,
    userPhone: string,
    config: ReturnType<typeof loadConfig>,
): Promise<void> {
    const sendParams: SendParams = {
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
        apiToken: config.WHATSAPP_API_TOKEN,
    };

    // ── Extract text and media from the message ─────────────────────────
    const { text, media, rawLabel } = await extractContent(msg, config.WHATSAPP_API_TOKEN);

    // Skip unsupported message types silently
    if (text === null && !media) {
        console.log(`[SUMA] ⏭️ Ignoring message type: ${msg.type} from ${userPhone}`);
        return;
    }

    console.log(`[SUMA] 📩 Processing ${msg.type} from ${userPhone}: "${text ?? "[media]"}"`);

    // ── Run the intent parser ───────────────────────────────────────────
    const parsed: ParsedIntent = await parseTransaction(
        text ?? "",
        config.GEMINI_API_KEY,
        media,
    );

    console.log(`[SUMA] 🧠 Intent: ${parsed.intent}`, parsed.transaction_data
        ? `| ${parsed.transaction_data.type} $${parsed.transaction_data.amount}`
        : "",
    );

    // ── Route by intent ─────────────────────────────────────────────────
    switch (parsed.intent) {
        case "record_transaction":
            await handleRecordTransaction(
                userPhone,
                parsed.transaction_data!,
                rawLabel,
                sendParams,
            );
            break;

        case "query":
            // Phase 4 will implement actual query logic
            await sendWhatsAppMessage({
                to: userPhone,
                text: parsed.reply_message || "📊 La funcionalidad de consultas estará disponible pronto.",
                ...sendParams,
            });
            break;

        case "system_command":
            await sendWhatsAppMessage({
                to: userPhone,
                text: parsed.reply_message || formatHelpMessage(),
                ...sendParams,
            });
            break;

        case "unknown":
        default:
            await sendWhatsAppMessage({
                to: userPhone,
                text: parsed.reply_message || formatHelpMessage(),
                ...sendParams,
            });
            break;
    }
}

// ---------------------------------------------------------------------------
// Content extraction — normalizes text/audio/image into a common shape
// ---------------------------------------------------------------------------

interface ExtractedContent {
    text: string | null;
    media?: MediaContent;
    rawLabel: string;
}

async function extractContent(
    msg: WhatsAppMessage,
    apiToken: string,
): Promise<ExtractedContent> {
    switch (msg.type) {
        case "text":
            return {
                text: msg.text?.body ?? null,
                rawLabel: msg.text?.body ?? "",
            };

        case "audio":
            if (!msg.audio) return { text: null, rawLabel: "" };
            return {
                text: "",
                media: await downloadWhatsAppMedia(msg.audio.id, apiToken),
                rawLabel: "[audio]",
            };

        case "image":
            if (!msg.image) return { text: null, rawLabel: "" };
            return {
                text: msg.image.caption ?? "",
                media: await downloadWhatsAppMedia(msg.image.id, apiToken),
                rawLabel: msg.image.caption ? `[imagen] ${msg.image.caption}` : "[imagen]",
            };

        default:
            return { text: null, rawLabel: "" };
    }
}

// ---------------------------------------------------------------------------
// Intent handler: record_transaction
// ---------------------------------------------------------------------------

async function handleRecordTransaction(
    userPhone: string,
    data: ParsedTransactionData,
    rawMessage: string,
    sendParams: SendParams,
): Promise<void> {
    const userInfo = await upsertUser(userPhone);

    // Resolve account and category in parallel
    const [accountId, categoryId] = await Promise.all([
        ensureDefaultAccount(userInfo.id),
        resolveCategoryId(data.category),
    ]);

    await insertTransaction({
        user_id: userInfo.id,
        type: data.type,
        amount: data.amount,
        description: data.description,
        category_id: categoryId,
        account_id: accountId,
        is_recurrent: false,
        raw_message: rawMessage,
    });

    console.log(
        `[SUMA] 💾 ${data.type} saved: $${data.amount} — ${data.description} [${data.category}]`,
    );

    await sendWhatsAppMessage({
        to: userPhone,
        text: formatTransactionSuccess(data),
        ...sendParams,
    });
}
