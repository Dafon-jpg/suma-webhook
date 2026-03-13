// ============================================================================
// SUMA — Message Processing Worker (api/process-message.ts)
//
// Sección 3: Intent-based routing.
//
// This endpoint is called by QStash (not directly by Meta).
// Pipeline:
//   1. Verify QStash signature
//   2. Check idempotency (skip if already processed)
//   3. Parse message → classify intent via type-specific parsers
//   4. Route by intent: record | query | system_command | unknown
//   5. Return 200 on success (or 5xx for QStash to retry)
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import type {
    QueuedMessagePayload,
    WhatsAppMessage,
    ParsedIntent,
    ChatMessage,
} from "../src/types/index.js";
import { loadConfig } from "../src/utils/config.js";
import { verifyQStashSignature } from "../src/queue/qstash.js";
import {
    claimMessageId,
    markMessageProcessed,
    markMessageError,
} from "../src/services/idempotency.js";
import { parseText, parseAudio, parseImage } from "../src/services/parsers/index.js";
import type { ParseOptions } from "../src/services/parsers/index.js";
import {
    upsertUser,
    getMonthlyTransactionCount,
} from "../src/services/transaction-repository.js";
import {
    sendSimpleText,
    sendPostConfirmationButtons,
    sendAlertButtons,
} from "../src/services/whatsapp.js";
import {
    scheduleAlert,
    getDefaultAlertDate,
    renewSubscription,
    cancelSubscription,
} from "../src/services/alerts.js";
import {
    createPending,
    getPending,
    sendConfirmation,
    confirmAndSave,
    startFieldCorrection,
    selectFieldToEdit,
    applyFieldCorrection,
} from "../src/services/confirmation-flow.js";
import { getRecentHistory, saveMessage } from "../src/services/chat-memory.js";
import { getSupabaseClient } from "../src/lib/supabase.js";
import type { IncomingMessage } from "node:http";

// Diagnostic: if you don't see this in logs, the module failed to load
console.log("[SUMA] ✅ process-message module loaded");

// ---------------------------------------------------------------------------
// Raw body reader — needed for accurate QStash signature verification
// ---------------------------------------------------------------------------

/**
 * Reads the raw request body as a UTF-8 string.
 * We disable Vercel's body parser (see config export at the bottom)
 * to get the exact bytes QStash signed — JSON.stringify(req.body) can
 * differ from the original payload and break signature verification.
 */
function getRawBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(
    req: VercelRequest,
    res: VercelResponse,
): Promise<void> {
    // Top-level diagnostic — always logs regardless of what happens below
    console.log(`[SUMA] 📥 process-message hit: ${req.method} from ${req.headers["user-agent"]?.slice(0, 50) ?? "unknown"}`);

    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    try {
        const config = loadConfig();

        // ── Step 1: Read raw body & verify QStash signature ─────────────
        const rawBody = await getRawBody(req);
        const signature = req.headers["upstash-signature"] as string | undefined;

        console.log(`[SUMA] 🔐 Signature present: ${!!signature}, body length: ${rawBody.length}`);

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

        // ── Step 2: Parse the payload ───────────────────────────────────
        const payload: QueuedMessagePayload = JSON.parse(rawBody);
        const { message: msg } = payload;
        const userPhone = msg.from.replace(/^549/, "54");

        // Extract WhatsApp profile name from contacts (if available)
        const waProfileName = payload.contacts?.[0]?.profile?.name ?? null;

        console.log(`[SUMA] 📨 Message ${msg.id} from ${userPhone} (type: ${msg.type})`);

        // ── Step 3: Idempotency check ──────────────────────────────────
        const claimed = await claimMessageId(msg.id, userPhone);
        if (!claimed) {
            console.log(`[SUMA] ♻️ Duplicate message ${msg.id} — skipping`);
            res.status(200).json({ status: "duplicate", wamid: msg.id });
            return;
        }

        // ── Step 4: Process the message ────────────────────────────────
        await processMessage(msg, userPhone, config, waProfileName);
        await markMessageProcessed(msg.id);
        res.status(200).json({ status: "processed", wamid: msg.id });

    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[SUMA] ❌ Top-level error:`, errorMsg);

        // Try to mark error if we have a message ID
        try {
            const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
            if (body?.message?.id) {
                await markMessageError(body.message.id, errorMsg);
            }
        } catch {
            // Can't extract message ID — just log
        }

        res.status(500).json({ error: "Processing failed" });
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
// Supported message types for parsing
// ---------------------------------------------------------------------------

const PARSEABLE_TYPES = new Set(["text", "audio", "image"]);

// ---------------------------------------------------------------------------
// Message processing pipeline — Fase 1: full conversational flow
// ---------------------------------------------------------------------------

async function processMessage(
    msg: WhatsAppMessage,
    userPhone: string,
    config: ReturnType<typeof loadConfig>,
    waProfileName: string | null = null,
): Promise<void> {
    const sendParams: SendParams = {
        phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
        apiToken: config.WHATSAPP_API_TOKEN,
    };

    // ── PASO 1: Detectar si es respuesta interactiva (botones/listas) ───
    // Must be checked BEFORE extractContent, which returns null for interactive
    if (msg.type === "interactive") {
        await handleInteractiveReply(msg, userPhone, sendParams);
        return;
    }

    // ── PASO 2: Validar tipo de mensaje ─────────────────────────────────
    if (!PARSEABLE_TYPES.has(msg.type)) {
        console.log(`[SUMA] ⏭️ Ignoring message type: ${msg.type} from ${userPhone}`);
        return;
    }

    // Extract text early for text messages (needed for onboarding, field editing, logging)
    const text = msg.type === "text" ? (msg.text?.body ?? null) : null;
    const rawLabel = msg.type === "text"
        ? (msg.text?.body ?? "")
        : msg.type === "audio"
            ? "[audio]"
            : msg.image?.caption ? `[imagen] ${msg.image.caption}` : "[imagen]";

    // For text messages, reject null text
    if (msg.type === "text" && text === null) {
        console.log(`[SUMA] ⏭️ Empty text message from ${userPhone}`);
        return;
    }

    console.log(`[SUMA] 📩 Processing ${msg.type} from ${userPhone}: "${text ?? rawLabel}"`);

    // ── PASO 3: upsertUser ──────────────────────────────────────────────
    const user = await upsertUser(userPhone);

    // ── PASO 4: Check si usuario está suscripto ─────────────────────────
    console.log(`[SUMA] 👤 User ${userPhone}: subscriptionStatus="${user.subscriptionStatus}", isSubscribed=${user.isSubscribed}`);
    if (user.subscriptionStatus !== "active" && !user.isSubscribed) {
        await sendSimpleText({
            to: userPhone,
            ...sendParams,
            text: "¡Hola! 👋 Soy Suma, tu asistente financiero por WhatsApp.\n\n" +
                "Para usar todas mis funciones necesitás una cuenta activa.\n" +
                "Registrate en 👉 https://suma.digital",
        });
        await saveMessage(user.id, "user", text ?? rawLabel);
        await saveMessage(user.id, "assistant", "[Mensaje de invitación a suscribirse]");
        return;
    }

    // ── PASO 5a: Check si hay pending_confirmation con field_editing ─────
    const pending = await getPending(user.id);
    if (pending !== null && pending.field_editing !== null) {
        await applyFieldCorrection(pending.id, text ?? "", userPhone, sendParams);
        await saveMessage(user.id, "user", text ?? rawLabel);
        await saveMessage(user.id, "assistant", "[Confirmación actualizada]");
        return;
    }

    // ── PASO 5b: Check si estamos esperando fecha de alerta personalizada ──
    if (text && msg.type === "text") {
        const history5b = await getRecentHistory(user.id);
        const lastSystem = history5b
            .filter((m: ChatMessage) => m.role === "system")
            .pop();

        if (lastSystem?.content?.startsWith("[awaiting_alert_date:")) {
            const subId = lastSystem.content.replace("[awaiting_alert_date:", "").replace("]", "");
            const parsedDate = parseCustomDate(text);

            if (parsedDate) {
                try {
                    await scheduleAlert(subId, parsedDate);
                    const formatted = `${String(parsedDate.getUTCDate()).padStart(2, "0")}/${String(parsedDate.getUTCMonth() + 1).padStart(2, "0")}/${parsedDate.getUTCFullYear()}`;
                    await sendSimpleText({
                        to: userPhone, ...sendParams,
                        text: `🔔 Listo, te aviso el ${formatted}.`,
                    });
                } catch (err) {
                    console.error(`[SUMA] ❌ Custom alert scheduling failed:`, err);
                    await sendSimpleText({
                        to: userPhone, ...sendParams,
                        text: "⚠️ No pude programar el recordatorio. Intentá más tarde.",
                    });
                }
            } else {
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: "⚠️ No entendí la fecha. Escribila como DD/MM/YYYY (ej: 01/09/2026).",
                });
            }

            // Clear the awaiting state
            await saveMessage(user.id, "user", text);
            await saveMessage(user.id, "system", "[alert_date_processed]");
            return;
        }
    }

    // ── PASO 6: Onboarding — 3 escenarios según origen del usuario ─────

    // ESCENARIO A: Usuario registrado por la web, primer mensaje al bot
    if (user.onboardingSource === "web") {
        const recentHistory = await getRecentHistory(user.id);
        if (recentHistory.length === 0) {
            // Primer contacto — saludo corto personalizado (se muestra UNA sola vez)
            await sendSimpleText({
                to: userPhone,
                ...sendParams,
                text: `¡Hola ${user.name}! 👋 Soy Suma, tu asistente financiero.\n` +
                    "Ya tengo tus datos del registro en suma.digital.\n\n" +
                    'Empezá a contarme tus movimientos: _"Gasté 5000 en pizza"_ 🍕',
            });
            await saveMessage(user.id, "user", text ?? rawLabel);
            await saveMessage(user.id, "assistant", "[Bienvenida usuario web]");
            return;
        }
        // ESCENARIO B: Usuario web que ya habló antes → continuar al PASO 7
    }

    // ESCENARIO C: Usuario sin registro web (whatsapp o unknown)
    if (user.onboardingSource !== "web" && user.name === null) {
        // Check if the user is responding to "¿Cómo te llamás?"
        const recentHistory = await getRecentHistory(user.id);
        const lastAssistantMsg = recentHistory
            .filter((m: ChatMessage) => m.role === "assistant")
            .pop();

        if (lastAssistantMsg?.content?.includes("¿Cómo te llamás?") || lastAssistantMsg?.content?.includes("Onboarding iniciado")) {
            // User is replying with their name
            const userName = text?.trim() ?? waProfileName ?? "Usuario";
            await updateUserName(user.id, userName);
            await sendSimpleText({
                to: userPhone,
                ...sendParams,
                text: `¡Encantado, ${userName}! 😊 Ya estás listo para empezar.\n\n` +
                    'Probá escribirme algo como _"Gasté 5000 en pizza"_',
            });
            await saveMessage(user.id, "user", text ?? rawLabel);
            await saveMessage(user.id, "assistant", `[Nombre guardado: ${userName}]`);
            return;
        }

        // First time — use WhatsApp profile name if available
        if (waProfileName) {
            await updateUserName(user.id, waProfileName);
            await saveMessage(user.id, "system", `Nombre obtenido de WhatsApp: ${waProfileName}`);
            await sendSimpleText({
                to: userPhone,
                ...sendParams,
                text: `¡Hola ${waProfileName}! 👋 Soy Suma, tu asistente financiero.\n\n` +
                    "Puedo ayudarte a llevar el control de tus finanzas. " +
                    "Decime cosas como:\n" +
                    '• _"Cobré 250.000 de un freelance"_\n' +
                    '• _"Gasté 15.000 en el super"_\n' +
                    '• _"Me suscribí a Netflix"_\n\n' +
                    "Antes de guardar cualquier movimiento, te voy a pedir que confirmes los datos. " +
                    "Así nunca se registra nada mal 😊",
            });
            await saveMessage(user.id, "assistant", "[Onboarding con nombre de WhatsApp]");
            return;
        }

        // No WhatsApp name available — ask for it
        await saveMessage(user.id, "system", "Usuario nuevo suscripto. Iniciar onboarding.");
        await sendSimpleText({
            to: userPhone,
            ...sendParams,
            text: "¡Hola! 👋 Soy Suma, tu asistente financiero.\n\n" +
                "Puedo ayudarte a llevar el control de tus finanzas. " +
                "Decime cosas como:\n" +
                '• _"Cobré 250.000 de un freelance"_\n' +
                '• _"Gasté 15.000 en el super"_\n' +
                '• _"Me suscribí a Netflix"_\n\n' +
                "Antes de guardar cualquier movimiento, te voy a pedir que confirmes los datos. " +
                "Así nunca se registra nada mal 😊\n\n" +
                "¿Cómo te llamás?",
        });
        await saveMessage(user.id, "assistant", "[Onboarding iniciado]");
        return;
    }

    // ── PASO 7: Cargar contexto para Gemini ─────────────────────────────
    const [history, monthlyCount] = await Promise.all([
        getRecentHistory(user.id),
        getMonthlyTransactionCount(user.id),
    ]);

    const parseOptions: ParseOptions = {
        userName: user.name ?? undefined,
        subscriptionStatus: user.subscriptionStatus,
        monthlyTxCount: monthlyCount,
        conversationHistory: history,
    };

    // ── PASO 8: Rutear al parser específico por tipo de mensaje ─────────
    let parsed: ParsedIntent;

    switch (msg.type) {
        case "audio":
            parsed = await parseAudio(
                msg.audio!.id,
                config.WHATSAPP_API_TOKEN,
                config.GEMINI_API_KEY!,
                config.GEMINI_MODEL,
                parseOptions,
            );
            break;

        case "image":
            parsed = await parseImage(
                msg.image!.id,
                config.WHATSAPP_API_TOKEN,
                config.GEMINI_API_KEY!,
                config.GEMINI_MODEL,
                msg.image?.caption,
                parseOptions,
            );
            break;

        case "text":
        default:
            parsed = await parseText(
                text!,
                config.GEMINI_API_KEY!,
                config.GEMINI_MODEL,
                parseOptions,
            );
            break;
    }

    const intentLog = parsed.transaction_data
        ? `| ${parsed.transaction_data.type} $${parsed.transaction_data.amount}`
        : "";
    console.log(`[SUMA] 🧠 Intent: ${parsed.intent} ${intentLog}`);

    // Guardar mensaje del usuario en historial
    await saveMessage(user.id, "user", text ?? rawLabel);

    // ── PASO 9: Routing por intent ──────────────────────────────────────
    switch (parsed.intent) {
        case "record_transaction": {
            if (!parsed.transaction_data) {
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: "⚠️ No pude interpretar los datos. Probá de nuevo.",
                });
                await saveMessage(user.id, "assistant", "[Error: sin datos de transacción]");
                break;
            }
            await createPending(user.id, parsed.transaction_data, "transaction");
            const pendingRow = await getPending(user.id);
            await sendConfirmation(pendingRow!, userPhone, sendParams);
            await saveMessage(user.id, "assistant", "[Confirmación enviada]");
            break;
        }

        case "subscription": {
            if (!parsed.subscription_data) {
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: "⚠️ No pude interpretar los datos de la suscripción. Probá de nuevo.",
                });
                await saveMessage(user.id, "assistant", "[Error: sin datos de suscripción]");
                break;
            }
            await createPending(user.id, parsed.subscription_data, "subscription");
            const subPending = await getPending(user.id);
            await sendConfirmation(subPending!, userPhone, sendParams);
            await saveMessage(user.id, "assistant", "[Confirmación de suscripción enviada]");
            break;
        }

        case "query":
            await sendSimpleText({
                to: userPhone, ...sendParams,
                text: parsed.reply_message || "📊 Las consultas financieras van a estar disponibles pronto.",
            });
            await saveMessage(user.id, "assistant", parsed.reply_message || "[Consulta]");
            break;

        case "system_command":
            if (parsed.reply_message === "undo") {
                await handleUndo(user.id, userPhone, sendParams);
            } else {
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: parsed.reply_message || 'Escribí _"ayuda"_ para ver qué puedo hacer.',
                });
            }
            await saveMessage(user.id, "assistant", parsed.reply_message || "[Comando de sistema]");
            break;

        case "unknown":
        default: {
            // Detectar si el usuario está respondiendo a "¿Cómo te llamás?"
            const lastAssistantMsg = history
                .filter((m: ChatMessage) => m.role === "assistant")
                .pop();

            if (lastAssistantMsg?.content?.includes("¿Cómo te llamás?")) {
                await updateUserName(user.id, text ?? "");
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: `¡Encantado, ${text}! 😊 Ya estás listo para empezar.\n\n` +
                        'Probá escribirme algo como _"Gasté 5000 en pizza"_',
                });
                await saveMessage(user.id, "assistant", `[Nombre guardado: ${text}]`);
            } else {
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: parsed.reply_message || '🤔 No entendí. Probá con algo como _"Gasté 5000 en pizza"_',
                });
                await saveMessage(user.id, "assistant", parsed.reply_message || "[No entendido]");
            }
            break;
        }
    }
}

// ---------------------------------------------------------------------------
// Interactive reply handler — buttons & lists
// ---------------------------------------------------------------------------

async function handleInteractiveReply(
    msg: WhatsAppMessage,
    userPhone: string,
    sendParams: SendParams,
): Promise<void> {
    const buttonReply = msg.interactive?.button_reply;
    const listReply = msg.interactive?.list_reply;

    if (!buttonReply && !listReply) return;

    const replyId = buttonReply?.id ?? listReply?.id ?? "";
    const user = await upsertUser(userPhone);

    console.log(`[SUMA] 🔘 Interactive reply from ${userPhone}: "${replyId}"`);

    // ── Confirmar transacción (Sí) ──
    if (replyId.startsWith("confirm_yes_")) {
        const confirmationId = replyId.replace("confirm_yes_", "");

        // Step 1: try to confirm and save the transaction
        let result: { transactionId: string; summary: string; subscriptionId?: string; endDate?: string; serviceName?: string };
        try {
            result = await confirmAndSave(confirmationId, user.id);
            console.log(`[SUMA] ✅ Transaction saved: ${result.transactionId}`);
        } catch (err) {
            console.error(`[SUMA] ❌ confirmAndSave failed:`, err);
            // Pending was already consumed (double-tap) or expired
            await sendSimpleText({
                to: userPhone, ...sendParams,
                text: "⚠️ Ese movimiento ya fue procesado o expiró. Si necesitás registrar otro, escribilo de nuevo.",
            });
            return;
        }

        // Step 2: If subscription with end_date → send alert buttons instead of undo
        if (result.subscriptionId && result.endDate) {
            try {
                await sendAlertButtons({
                    to: userPhone, ...sendParams,
                    subscriptionId: result.subscriptionId,
                    serviceName: result.serviceName!,
                    endDate: result.endDate,
                });
            } catch (alertErr) {
                console.error(`[SUMA] ⚠️ Alert buttons failed, falling back to text:`, alertErr);
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: "✅ *Suscripción registrada correctamente.*\n\n" + result.summary,
                });
            }
            await saveMessage(user.id, "user", "[Confirmó: Sí]");
            await saveMessage(user.id, "assistant", "[Suscripción guardada — pregunta de alerta enviada]");
            return;
        }

        // Step 3: Regular transaction/subscription → send undo button
        try {
            await sendPostConfirmationButtons({
                to: userPhone, ...sendParams,
                summaryText: "✅ *Registrado*\n\n" + result.summary,
                transactionId: result.transactionId,
            });
        } catch (sendErr) {
            console.error(`[SUMA] ⚠️ Post-confirmation buttons failed, falling back to text:`, sendErr);
            await sendSimpleText({
                to: userPhone, ...sendParams,
                text: "✅ *Registrado correctamente.*\n\n" + result.summary,
            });
        }

        await saveMessage(user.id, "user", "[Confirmó: Sí]");
        await saveMessage(user.id, "assistant", "[Transacción guardada]");
        return;
    }

    // ── Rechazar y corregir (No) ──
    if (replyId.startsWith("confirm_no_")) {
        const confirmationId = replyId.replace("confirm_no_", "");
        try {
            await startFieldCorrection(confirmationId, userPhone, sendParams);
            await saveMessage(user.id, "user", "[Confirmó: No, quiere corregir]");
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(`[SUMA] ❌ confirm_no failed:`, errMsg);

            if (errMsg.includes("no encontrada") || errMsg.includes("not found")) {
                // Pending was already consumed (double-tap) or expired
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: "⚠️ Ese movimiento ya fue procesado o expiró. Si necesitás registrar otro, escribilo de nuevo.",
                });
            } else {
                // WhatsApp list message failed — fallback to text-based correction
                console.error(`[SUMA] ⚠️ List message failed, falling back to text prompt`);
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: "✏️ No pude mostrar la lista de campos. Escribime directamente qué querés corregir, por ejemplo:\n\n" +
                        "• _\"El monto es 8000\"_\n" +
                        "• _\"La categoría es transporte\"_\n" +
                        "• _\"Es un ingreso, no un gasto\"_",
                });
            }
        }
        return;
    }

    // ── Selección de campo a corregir ──
    if (replyId.startsWith("field_")) {
        // Patrón: field_{fieldName}_{uuid}
        // UUID siempre tiene 36 chars
        const confirmationId = replyId.slice(-36);
        const fieldName = replyId.slice(6, -(36 + 1)); // "field_" = 6 chars, "_" before UUID = 1
        await selectFieldToEdit(confirmationId, fieldName, userPhone, sendParams);
        await saveMessage(user.id, "user", `[Seleccionó campo: ${fieldName}]`);
        return;
    }

    // ── Undo post-confirmación ──
    if (replyId.startsWith("undo_")) {
        const transactionId = replyId.replace("undo_", "");
        await handleUndoById(user.id, transactionId, userPhone, sendParams);
        await saveMessage(user.id, "user", "[Deshizo última transacción]");
        return;
    }

    // ── Alert: Sí, recordame ──
    if (replyId.startsWith("alert_yes_")) {
        const subId = replyId.replace("alert_yes_", "");
        try {
            const supabase = getSupabaseClient();
            const { data: sub } = await supabase
                .from("subscriptions")
                .select("end_date, service_name")
                .eq("id", subId)
                .single();

            if (sub?.end_date) {
                const alertDate = getDefaultAlertDate(sub.end_date);
                await scheduleAlert(subId, alertDate);
                const formatted = `${String(alertDate.getUTCDate()).padStart(2, "0")}/${String(alertDate.getUTCMonth() + 1).padStart(2, "0")}/${alertDate.getUTCFullYear()}`;
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: `🔔 Listo, te voy a avisar el ${formatted} antes de que venza tu suscripción a *${sub.service_name}*.`,
                });
            } else {
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: "⚠️ No encontré la suscripción o no tiene fecha de vencimiento.",
                });
            }
        } catch (err) {
            console.error(`[SUMA] ❌ alert_yes failed:`, err);
            await sendSimpleText({
                to: userPhone, ...sendParams,
                text: "⚠️ No pude programar el recordatorio. Intentá más tarde.",
            });
        }
        await saveMessage(user.id, "user", "[Eligió: Sí, recordame]");
        await saveMessage(user.id, "assistant", "[Alerta programada]");
        return;
    }

    // ── Alert: No, gracias ──
    if (replyId.startsWith("alert_no_")) {
        await sendSimpleText({
            to: userPhone, ...sendParams,
            text: "👍 Perfecto, no te voy a enviar recordatorio.",
        });
        await saveMessage(user.id, "user", "[Eligió: No, gracias]");
        await saveMessage(user.id, "assistant", "[Sin alerta]");
        return;
    }

    // ── Alert: Elegir fecha ──
    if (replyId.startsWith("alert_custom_")) {
        const subId = replyId.replace("alert_custom_", "");
        // Store the subscription ID in chat memory so next text message is treated as date input
        await saveMessage(user.id, "system", `[awaiting_alert_date:${subId}]`);
        await sendSimpleText({
            to: userPhone, ...sendParams,
            text: "📅 ¿Qué fecha querés que te avise? Escribilo como DD/MM/YYYY (ej: 01/09/2026).",
        });
        await saveMessage(user.id, "user", "[Eligió: Elegir fecha]");
        await saveMessage(user.id, "assistant", "[Esperando fecha de alerta]");
        return;
    }

    // ── Renovar suscripción ──
    if (replyId.startsWith("renew_")) {
        const subId = replyId.replace("renew_", "");
        const renewed = await renewSubscription(subId);
        if (renewed) {
            const endFormatted = renewed.end_date
                ? `${String(new Date(renewed.end_date).getUTCDate()).padStart(2, "0")}/${String(new Date(renewed.end_date).getUTCMonth() + 1).padStart(2, "0")}/${new Date(renewed.end_date).getUTCFullYear()}`
                : "indefinida";
            await sendSimpleText({
                to: userPhone, ...sendParams,
                text: `🔄 *Suscripción renovada:* ${renewed.service_name}\n📆 Nueva vigencia hasta: ${endFormatted}`,
            });
        } else {
            await sendSimpleText({
                to: userPhone, ...sendParams,
                text: "⚠️ No pude renovar la suscripción. Puede que ya no exista.",
            });
        }
        await saveMessage(user.id, "user", "[Renovó suscripción]");
        await saveMessage(user.id, "assistant", "[Suscripción renovada]");
        return;
    }

    // ── Cancelar suscripción ──
    if (replyId.startsWith("cancel_sub_")) {
        const subId = replyId.replace("cancel_sub_", "");
        const cancelled = await cancelSubscription(subId);
        if (cancelled) {
            await sendSimpleText({
                to: userPhone, ...sendParams,
                text: "❌ Suscripción cancelada. Ya no vas a recibir recordatorios sobre ella.",
            });
        } else {
            await sendSimpleText({
                to: userPhone, ...sendParams,
                text: "⚠️ No pude cancelar la suscripción. Intentá más tarde.",
            });
        }
        await saveMessage(user.id, "user", "[Canceló suscripción]");
        await saveMessage(user.id, "assistant", "[Suscripción cancelada]");
        return;
    }
}

// ---------------------------------------------------------------------------
// Undo handlers
// ---------------------------------------------------------------------------

async function handleUndo(
    userId: string,
    phone: string,
    sendParams: SendParams,
): Promise<void> {
    const supabase = getSupabaseClient();

    const { data } = await supabase
        .from("transactions")
        .select("id, description, amount, type")
        .eq("user_id", userId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

    if (!data) {
        await sendSimpleText({
            to: phone, ...sendParams,
            text: "No tenés transacciones para deshacer.",
        });
        return;
    }

    await supabase
        .from("transactions")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", data.id);

    await sendSimpleText({
        to: phone, ...sendParams,
        text: `✅ Deshice el último registro: ${data.description} $${data.amount}`,
    });
}

async function handleUndoById(
    userId: string,
    transactionId: string,
    phone: string,
    sendParams: SendParams,
): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
        .from("transactions")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", transactionId)
        .eq("user_id", userId)
        .is("deleted_at", null);

    if (error) {
        await sendSimpleText({
            to: phone, ...sendParams,
            text: "⚠️ No se pudo deshacer. Puede que ya fue eliminada.",
        });
        return;
    }

    await sendSimpleText({
        to: phone, ...sendParams,
        text: "✅ Transacción deshecha correctamente.",
    });
}

// ---------------------------------------------------------------------------
// User helpers
// ---------------------------------------------------------------------------

async function updateUserName(userId: string, name: string): Promise<void> {
    const supabase = getSupabaseClient();
    await supabase.from("users").update({ name }).eq("id", userId);
}

// ---------------------------------------------------------------------------
// Date parser for custom alert dates
// ---------------------------------------------------------------------------

/**
 * Parses DD/MM/YYYY or DD-MM-YYYY into a UTC Date. Returns null on failure.
 */
function parseCustomDate(input: string): Date | null {
    const match = input.trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
    if (!match) return null;

    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1; // 0-indexed
    const year = parseInt(match[3], 10);

    if (month < 0 || month > 11 || day < 1 || day > 31 || year < 2024) return null;

    const date = new Date(Date.UTC(year, month, day));
    // Validate the date is real (e.g., 31/02 would roll over)
    if (date.getUTCDate() !== day || date.getUTCMonth() !== month) return null;

    return date;
}

// ---------------------------------------------------------------------------
// Vercel config — disable body parser for raw body signature verification
// ---------------------------------------------------------------------------

export const config = {
    api: { bodyParser: false },
};