// ============================================================================
// WhatsApp Cloud API — send messages back to the user
// ============================================================================

import type { ParsedTransactionData, TransactionType } from "../types/index.js";

const WA_API_BASE = "https://graph.facebook.com/v21.0";

interface SendMessageParams {
  to: string;
  text: string;
  phoneNumberId: string;
  apiToken: string;
}

/**
 * Sends a text message via WhatsApp Cloud API.
 */
export async function sendWhatsAppMessage({
  to,
  text,
  phoneNumberId,
  apiToken,
}: SendMessageParams): Promise<void> {
  const url = `${WA_API_BASE}/${phoneNumberId}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[SUMA] WhatsApp API error (${res.status}):`, errBody);
    throw new Error(`WhatsApp send failed: ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Message formatters (Sección 3 — intent-aware)
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<TransactionType, { emoji: string; label: string }> = {
  expense: { emoji: "💸", label: "Gasto registrado" },
  income: { emoji: "💰", label: "Ingreso registrado" },
  transfer: { emoji: "🔄", label: "Transferencia registrada" },
};

/**
 * Formats a success message after saving a transaction.
 * Adapts emoji and wording based on transaction type.
 */
export function formatTransactionSuccess(data: ParsedTransactionData): string {
  const formatted = data.amount.toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  });

  const { emoji, label } = TYPE_LABELS[data.type];

  return [
    `✅ *${label}*`,
    ``,
    `${emoji} *Monto:* ${formatted}`,
    `📝 *Descripción:* ${data.description}`,
    `🏷️ *Categoría:* ${data.category}`,
    `🏦 *Cuenta:* ${data.account}`,
    ``,
    `_Enviá "resumen" para ver tus movimientos del mes._`,
  ].join("\n");
}

/**
 * @deprecated Use formatTransactionSuccess instead.
 * Kept temporarily for backward compatibility.
 */
export function formatSuccessMessage(
  amount: number,
  description: string,
  category: string,
): string {
  const formatted = amount.toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  });

  return [
    `✅ *Gasto registrado*`,
    ``,
    `💰 *Monto:* ${formatted}`,
    `📝 *Descripción:* ${description}`,
    `🏷️ *Categoría:* ${category}`,
    ``,
    `_Enviá "resumen" para ver tus gastos del mes._`,
  ].join("\n");
}

/**
 * Formats an error/help message when parsing fails.
 */
export function formatHelpMessage(): string {
  return [
    `🤔 No entendí tu mensaje.`,
    ``,
    `Probá con alguno de estos formatos:`,
    `• _"Gasté 5000 en pizza"_`,
    `• _"Uber $3200"_`,
    `• _"Cobré 50000 de sueldo"_`,
    `• _"Transferí 10000 a MercadoPago"_`,
    ``,
    `_También podés escribir "resumen" o "ayuda"._`,
  ].join("\n");
}
