// ============================================================================
// SUMA — Sales Flow Service (src/services/sales-flow.ts)
//
// State machine for the in-WhatsApp subscription sales funnel.
// Handles: pitch, info, data capture (name/email), payment link, declines.
//
// Called from process-message.ts when user is NOT subscribed.
// ============================================================================

import type { WhatsAppMessage, UserInfo, SaleStage } from "../types/index.js";
import { getSupabaseClient } from "../lib/supabase.js";
import { sendSimpleText } from "./whatsapp.js";
import { saveMessage } from "./chat-memory.js";
import { upsertUser } from "./transaction-repository.js";

console.log("[SUMA:SALES] ✅ sales-flow module loaded");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SendParams {
    phoneNumberId: string;
    apiToken: string;
}

// ---------------------------------------------------------------------------
// MercadoPago integration
// ---------------------------------------------------------------------------

const SUMA_PRICE_ARS = Number(process.env.SUMA_MONTHLY_PRICE_ARS) || 2990;

/**
 * Creates a MercadoPago Checkout Pro preference and returns the checkout URL.
 */
async function createPaymentLink(email: string, userName: string): Promise<string> {
    const mpToken = process.env.MP_ACCESS_TOKEN;

    if (!mpToken) {
        console.warn("[SUMA:SALES] ⚠️ MP_ACCESS_TOKEN not set, returning placeholder link");
        return "https://www.mercadopago.com.ar (link de prueba — configurar MP_ACCESS_TOKEN)";
    }

    const res = await fetch("https://api.mercadopago.com/checkout/preferences", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mpToken}`,
        },
        body: JSON.stringify({
            items: [{
                title: "Suma Digital — Suscripción mensual",
                quantity: 1,
                unit_price: SUMA_PRICE_ARS,
                currency_id: "ARS",
            }],
            payer: {
                email,
                name: userName,
            },
            back_urls: {
                success: "https://suma.digital/gracias",
                failure: "https://suma.digital/error",
                pending: "https://suma.digital/pendiente",
            },
            auto_return: "approved",
            external_reference: email, // Used to match payment to user
            notification_url: process.env.VERCEL_URL
                ? `https://${process.env.VERCEL_URL}/api/payment-webhook`
                : undefined,
        }),
    });

    if (!res.ok) {
        const errBody = await res.text();
        console.error("[SUMA:SALES] ❌ MercadoPago error:", errBody);
        throw new Error(`MercadoPago preference creation failed: ${res.status}`);
    }

    const data = await res.json();
    return data.init_point as string;
}

// ---------------------------------------------------------------------------
// Sale stage updater
// ---------------------------------------------------------------------------

async function updateSaleStage(
    userId: string,
    stage: SaleStage | null,
    extraFields?: Record<string, unknown>,
): Promise<void> {
    const supabase = getSupabaseClient();
    await supabase
        .from("users")
        .update({ sale_stage: stage, ...extraFields })
        .eq("id", userId);
}

// ---------------------------------------------------------------------------
// WhatsApp interactive message senders for sales
// ---------------------------------------------------------------------------

const WA_API_BASE = "https://graph.facebook.com/v21.0";

async function callWhatsAppAPI(params: {
    phoneNumberId: string;
    apiToken: string;
    to: string;
    body: Record<string, unknown>;
}): Promise<void> {
    const url = `${WA_API_BASE}/${params.phoneNumberId}/messages`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${params.apiToken}`,
        },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            to: params.to,
            ...params.body,
        }),
    });
    if (!res.ok) {
        const errBody = await res.text();
        console.error(`[SUMA:SALES] ❌ WhatsApp API error (${res.status}):`, errBody);
        throw new Error(`WhatsApp send failed: ${res.status}`);
    }
}

/** Sends the initial pitch with 3 buttons */
async function sendPitchButtons(
    to: string,
    sendParams: SendParams,
    isRetry: boolean,
): Promise<void> {
    const bodyText = isRetry
        ? "¡Hola de nuevo! 👋 ¿Querés empezar a organizar tu plata con Suma?"
        : "¡Hola! 👋 Soy Suma, tu copiloto financiero por WhatsApp.\n\n" +
        "Te ayudo a registrar gastos, ingresos y suscripciones solo con un mensaje. " +
        "Vos hablás, yo organizo tu plata 💪";

    const buttons = isRetry
        ? [
            { type: "reply", reply: { id: "sale_subscribe", title: "💳 Sí, suscribirme" } },
            { type: "reply", reply: { id: "sale_decline", title: "👋 Ahora no" } },
        ]
        : [
            { type: "reply", reply: { id: "sale_subscribe", title: "💳 Suscribirme" } },
            { type: "reply", reply: { id: "sale_info", title: "❓ Contame más" } },
            { type: "reply", reply: { id: "sale_decline", title: "👋 No, gracias" } },
        ];

    await callWhatsAppAPI({
        ...sendParams,
        to,
        body: {
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: bodyText },
                action: { buttons },
            },
        },
    });
}

/** Sends the "more info" message with 2 buttons */
async function sendInfoButtons(to: string, sendParams: SendParams): Promise<void> {
    await callWhatsAppAPI({
        ...sendParams,
        to,
        body: {
            type: "interactive",
            interactive: {
                type: "button",
                body: {
                    text:
                        "Con Suma podés:\n" +
                        "✅ Registrar gastos y ingresos por texto, audio o foto\n" +
                        "✅ Trackear suscripciones con alertas de vencimiento\n" +
                        "✅ Llevar un historial organizado de toda tu plata\n\n" +
                        "Todo desde este chat, sin bajar ninguna app 📱",
                },
                action: {
                    buttons: [
                        { type: "reply", reply: { id: "sale_subscribe", title: "💳 Suscribirme" } },
                        { type: "reply", reply: { id: "sale_decline", title: "👋 No por ahora" } },
                    ],
                },
            },
        },
    });
}

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

function isValidEmail(text: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

// ---------------------------------------------------------------------------
// Main entry point — called from process-message.ts subscription gate
// ---------------------------------------------------------------------------

/**
 * Handles the entire sales flow for non-subscribed users.
 * Routes based on the user's current sale_stage.
 */
export async function handleSalesFlow(
    msg: WhatsAppMessage,
    user: UserInfo,
    userPhone: string,
    sendParams: SendParams,
    waProfileName: string | null = null,
): Promise<void> {
    const { saleStage, saleAttempts } = user;

    console.log(`[SUMA:SALES] 📊 User ${userPhone}: stage=${saleStage}, attempts=${saleAttempts}`);

    // ── Handle interactive replies (sale buttons) ───────────────────────
    if (msg.type === "interactive") {
        const replyId =
            msg.interactive?.button_reply?.id ??
            msg.interactive?.list_reply?.id ??
            "";

        if (replyId.startsWith("sale_")) {
            await handleSalesInteractive(replyId, user, userPhone, sendParams, waProfileName);
            return;
        }
    }

    // ── Route by current stage ──────────────────────────────────────────
    switch (saleStage) {
        case "capturing_name":
            await handleNameCapture(msg, user, userPhone, sendParams);
            return;

        case "capturing_email":
            await handleEmailCapture(msg, user, userPhone, sendParams);
            return;

        case "awaiting_payment":
            await sendSimpleText({
                to: userPhone, ...sendParams,
                text: "Estoy esperando la confirmación de tu pago 🕐\n\n" +
                    "Si ya pagaste, puede tardar unos segundos en confirmarse.\n" +
                    "Si necesitás el link de nuevo, escribime _\"link de pago\"_.",
            });
            await saveMessage(user.id, "assistant", "[Recordatorio: esperando pago]");
            return;

        case "declined_final":
            // Max attempts reached — passive message only
            if (isExplicitSubscribeRequest(msg)) {
                // User explicitly asks to subscribe, always honor this
                await startDataCapture(user, userPhone, sendParams, waProfileName);
            } else {
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: "¡Hola! Para usar Suma necesitás una suscripción activa.\n" +
                        'Si querés suscribirte, escribime _"quiero suscribirme"_ 😊',
                });
                await saveMessage(user.id, "assistant", "[Mensaje pasivo — sale_attempts maxed]");
            }
            return;

        case "declined":
            // User previously said no — check if we can try again
            if (saleAttempts < 2) {
                // Check if user is explicitly asking to subscribe
                if (isExplicitSubscribeRequest(msg)) {
                    await startDataCapture(user, userPhone, sendParams, waProfileName);
                } else {
                    await updateSaleStage(user.id, "pitch_sent", {
                        sale_attempts: saleAttempts + 1,
                    });
                    await sendPitchButtons(userPhone, sendParams, true);
                    await saveMessage(user.id, "assistant", "[Pitch de recontacto enviado]");
                }
            } else {
                // Max attempts — switch to declined_final
                await updateSaleStage(user.id, "declined_final");
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: "¡Hola! Para usar Suma necesitás una suscripción activa.\n" +
                        'Si querés suscribirte, escribime _"quiero suscribirme"_ 😊',
                });
                await saveMessage(user.id, "assistant", "[Mensaje pasivo — sale_attempts maxed]");
            }
            return;

        case "pitch_sent":
        case "info_sent":
            // User sent a text instead of tapping a button
            if (isExplicitSubscribeRequest(msg)) {
                await startDataCapture(user, userPhone, sendParams, waProfileName);
            } else {
                // Redirect back to the sales flow
                await sendSimpleText({
                    to: userPhone, ...sendParams,
                    text: "Para registrar gastos necesitás tener tu suscripción activa 😊\n" +
                        "¿Seguimos con eso?",
                });
                await sendPitchButtons(userPhone, sendParams, false);
                await saveMessage(user.id, "assistant", "[Redirigido al flujo de venta]");
            }
            return;

        default:
            // No stage (null) — first contact, send initial pitch
            if (isExplicitSubscribeRequest(msg)) {
                // User proactively asks to subscribe
                await updateSaleStage(user.id, "pitch_sent", {
                    sale_attempts: saleAttempts + 1,
                });
                await startDataCapture(user, userPhone, sendParams, waProfileName);
            } else {
                await updateSaleStage(user.id, "pitch_sent", {
                    sale_attempts: saleAttempts + 1,
                });
                await sendPitchButtons(userPhone, sendParams, false);
                await saveMessage(user.id, "user", msg.text?.body ?? "[primer contacto]");
                await saveMessage(user.id, "assistant", "[Pitch inicial enviado]");
            }
            return;
    }
}

// ---------------------------------------------------------------------------
// Interactive reply handler (sale buttons)
// ---------------------------------------------------------------------------

async function handleSalesInteractive(
    replyId: string,
    user: UserInfo,
    userPhone: string,
    sendParams: SendParams,
    waProfileName: string | null,
): Promise<void> {
    switch (replyId) {
        case "sale_subscribe":
            await startDataCapture(user, userPhone, sendParams, waProfileName);
            break;

        case "sale_info":
            await updateSaleStage(user.id, "info_sent");
            await sendInfoButtons(userPhone, sendParams);
            await saveMessage(user.id, "user", "[Tocó: Contame más]");
            await saveMessage(user.id, "assistant", "[Info de producto enviada]");
            break;

        case "sale_decline":
            if (user.saleAttempts >= 2) {
                await updateSaleStage(user.id, "declined_final");
            } else {
                await updateSaleStage(user.id, "declined");
            }
            await sendSimpleText({
                to: userPhone, ...sendParams,
                text: "Dale, sin problema 😊\n" +
                    "Si cambiás de opinión, escribime cuando quieras.\n" +
                    "¡Que andes bien! 👋",
            });
            await saveMessage(user.id, "user", "[Tocó: No, gracias]");
            await saveMessage(user.id, "assistant", "[Despedida de venta]");
            break;

        default:
            console.warn(`[SUMA:SALES] Unknown sale interactive: ${replyId}`);
    }
}

// ---------------------------------------------------------------------------
// Data capture helpers
// ---------------------------------------------------------------------------

/**
 * Starts the data capture flow. If we already have the name (from WhatsApp
 * profile), skip directly to email capture.
 */
async function startDataCapture(
    user: UserInfo,
    userPhone: string,
    sendParams: SendParams,
    waProfileName: string | null,
): Promise<void> {
    const existingName = user.name ?? waProfileName;

    if (existingName) {
        // We already have their name — save it and ask for email
        if (!user.name && waProfileName) {
            await updateUserField(user.id, "name", waProfileName);
        }
        await updateSaleStage(user.id, "capturing_email");
        await sendSimpleText({
            to: userPhone, ...sendParams,
            text: `¡Genial, ${existingName}! 🎉 Para completar tu suscripción necesito tu email\n` +
                "(es para mandarte el comprobante de pago).",
        });
        await saveMessage(user.id, "user", "[Quiere suscribirse]");
        await saveMessage(user.id, "assistant", "[Pidiendo email]");
    } else {
        // Need to ask for name first
        await updateSaleStage(user.id, "capturing_name");
        await sendSimpleText({
            to: userPhone, ...sendParams,
            text: "¡Genial! 🎉 Para armarte la cuenta necesito un par de datos.\n" +
                "¿Cómo te llamás?",
        });
        await saveMessage(user.id, "user", "[Quiere suscribirse]");
        await saveMessage(user.id, "assistant", "[Pidiendo nombre]");
    }
}

/** Handles user response during name capture stage */
async function handleNameCapture(
    msg: WhatsAppMessage,
    user: UserInfo,
    userPhone: string,
    sendParams: SendParams,
): Promise<void> {
    const name = msg.text?.body?.trim();

    if (!name || name.length < 2) {
        await sendSimpleText({
            to: userPhone, ...sendParams,
            text: "Necesito tu nombre para la cuenta 😊 ¿Cómo te llamás?",
        });
        return;
    }

    // Save name and advance to email capture
    await updateUserField(user.id, "name", name);
    await updateSaleStage(user.id, "capturing_email");

    await sendSimpleText({
        to: userPhone, ...sendParams,
        text: `¡Encantado, ${name}! 😊\n` +
            "¿Me pasás tu email? Lo necesito para el comprobante de pago.",
    });
    await saveMessage(user.id, "user", name);
    await saveMessage(user.id, "assistant", "[Pidiendo email]");
}

/** Handles user response during email capture stage */
async function handleEmailCapture(
    msg: WhatsAppMessage,
    user: UserInfo,
    userPhone: string,
    sendParams: SendParams,
): Promise<void> {
    const emailText = msg.text?.body?.trim() ?? "";

    if (!isValidEmail(emailText)) {
        await sendSimpleText({
            to: userPhone, ...sendParams,
            text: "Hmm, eso no parece un email válido 🤔\n" +
                "Probá con tu email completo, por ejemplo: _nombre@gmail.com_",
        });
        return;
    }

    // Save email, generate payment link, advance to awaiting_payment
    await updateUserField(user.id, "email", emailText);

    const userName = user.name ?? "Usuario";
    let paymentUrl: string;

    try {
        paymentUrl = await createPaymentLink(emailText, userName);
    } catch (err) {
        console.error("[SUMA:SALES] ❌ Payment link creation failed:", err);
        await sendSimpleText({
            to: userPhone, ...sendParams,
            text: "⚠️ Hubo un problema al generar el link de pago. " +
                "Intentá de nuevo en unos minutos, o escribime _\"quiero suscribirme\"_.",
        });
        return;
    }

    await updateSaleStage(user.id, "awaiting_payment");
    // Also set subscription_status to pending
    const supabase = getSupabaseClient();
    await supabase.from("users").update({ subscription_status: "pending" }).eq("id", user.id);

    const priceFormatted = SUMA_PRICE_ARS.toLocaleString("es-AR");
    await sendSimpleText({
        to: userPhone, ...sendParams,
        text: "Perfecto 👌\n\n" +
            "💳 *Tu suscripción a Suma*\n" +
            `📧 Email: ${emailText}\n` +
            `💰 Precio: $${priceFormatted}/mes\n\n` +
            "Tocá el link para completar el pago de forma segura:\n" +
            `👉 ${paymentUrl}\n\n` +
            "Cuando confirmes el pago, te aviso por acá ✅",
    });
    await saveMessage(user.id, "user", emailText);
    await saveMessage(user.id, "assistant", "[Link de pago enviado]");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if the user's message is an explicit request to subscribe */
function isExplicitSubscribeRequest(msg: WhatsAppMessage): boolean {
    const text = msg.text?.body?.toLowerCase().trim() ?? "";
    const subscribeKeywords = [
        "quiero suscribirme",
        "suscribirme",
        "suscribir",
        "quiero sumarme",
        "me suscribo",
        "quiero pagar",
        "quiero la suscripcion",
        "quiero la suscripción",
    ];
    return subscribeKeywords.some((kw) => text.includes(kw));
}

/** Updates a single user field in the DB */
async function updateUserField(
    userId: string,
    field: string,
    value: string,
): Promise<void> {
    const supabase = getSupabaseClient();
    await supabase.from("users").update({ [field]: value }).eq("id", userId);
}

// ---------------------------------------------------------------------------
// Post-payment activation (called from payment-webhook.ts)
// ---------------------------------------------------------------------------

/**
 * Activates the user's subscription after successful payment.
 * Sends a welcome message via WhatsApp.
 */
export async function activateSubscription(
    userPhone: string,
    sendParams: SendParams,
): Promise<void> {
    const user = await upsertUser(userPhone);

    // Update subscription status and clear sale stage
    const supabase = getSupabaseClient();
    await supabase.from("users").update({
        subscription_status: "active",
        is_subscribed: true,
        sale_stage: null,
    }).eq("id", user.id);

    const userName = user.name ?? "crack";

    await sendSimpleText({
        to: userPhone, ...sendParams,
        text: `✅ ¡Listo, ${userName}! Ya sos parte de Suma 🎉\n\n` +
            "Empezá a contarme tus movimientos, por ejemplo:\n" +
            '• _"Gasté 5000 en pizza"_\n' +
            '• _"Cobré 250.000 de un freelance"_\n' +
            '• _"Me suscribí a Netflix"_\n\n' +
            "Yo me encargo de organizar todo 💪",
    });
    await saveMessage(user.id, "assistant", "[Suscripción activada — bienvenida]");

    console.log(`[SUMA:SALES] ✅ Subscription activated for ${userPhone}`);
}
