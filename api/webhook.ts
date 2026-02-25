// ============================================================================
// SUMA — WhatsApp Webhook (modo prueba — comunicación bidireccional)
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";

// ---------------------------------------------------------------------------
// Variables de entorno
// ---------------------------------------------------------------------------
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID!;
const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN!;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN!;

const WA_API_URL = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

// ---------------------------------------------------------------------------
// Enviar mensaje de WhatsApp
// ---------------------------------------------------------------------------
async function sendWhatsAppMessage(to: string, text: string): Promise<void> {
  const res = await fetch(WA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_API_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[SUMA] ❌ WhatsApp API error (${res.status}):`, err);
    throw new Error(`WhatsApp send failed: ${res.status}`);
  }

  console.log(`[SUMA] ✅ Mensaje enviado a ${to}`);
}

// ---------------------------------------------------------------------------
// GET — Verificación del webhook
// ---------------------------------------------------------------------------
function handleVerification(req: VercelRequest, res: VercelResponse): void {
  const mode = req.query["hub.mode"] as string;
  const token = req.query["hub.verify_token"] as string;
  const challenge = req.query["hub.challenge"] as string;

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("[SUMA] ✅ Webhook verificado");
    res.status(200).send(challenge);
    return;
  }

  console.warn("[SUMA] ⚠️ Verificación fallida");
  res.status(403).json({ error: "Forbidden: invalid verify token" });
}

// ---------------------------------------------------------------------------
// POST — Procesar mensaje entrante
// ---------------------------------------------------------------------------
async function handleIncomingMessage(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Responder 200 inmediatamente para evitar reintentos de WhatsApp

  try {
    const body = req.body;

    if (body.object !== "whatsapp_business_account") return;

    // Extraer mensajes del payload
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const msg of change.value?.messages ?? []) {

          // Solo procesar mensajes de texto
          if (msg.type !== "text") continue;

          const from = msg.from;          // Número del remitente
          const numeroDestino = from.replace(/^549/, '54');
          const text = msg.text?.body;

          console.log(`[SUMA] 📩 Mensaje de ${from}: "${text}"`);

          // Respuesta fija de prueba
          await sendWhatsAppMessage(numeroDestino, "¡Hola! Soy Suma, tu bot de gastos.");
        }
      }
    }
    res.status(200).json({ status: "received" });
  } catch (err) {
    console.error("[SUMA] ❌ Error procesando webhook:", err);
  }
}

// ---------------------------------------------------------------------------
// Router principal
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