// ============================================================================
// WhatsApp Cloud API — send messages back to the user
// ============================================================================

import type { ParsedTransactionData, ParsedSubscription, TransactionType } from "../types/index.js";

const WA_API_BASE = "https://graph.facebook.com/v21.0";

interface SendMessageParams {
  to: string;
  text: string;
  phoneNumberId: string;
  apiToken: string;
}

// ---------------------------------------------------------------------------
// Generic WhatsApp API caller (private)
// ---------------------------------------------------------------------------

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
    console.error(`[SUMA] ❌ WhatsApp API error (${res.status}):`, errBody);
    throw new Error(`WhatsApp send failed: ${res.status}`);
  }
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

// ---------------------------------------------------------------------------
// Interactive message senders (Fase 2 — confirmation flow)
// ---------------------------------------------------------------------------

/**
 * Sends a simple text message via callWhatsAppAPI.
 */
export async function sendSimpleText(params: {
  to: string;
  phoneNumberId: string;
  apiToken: string;
  text: string;
}): Promise<void> {
  await callWhatsAppAPI({
    phoneNumberId: params.phoneNumberId,
    apiToken: params.apiToken,
    to: params.to,
    body: {
      type: "text",
      text: { body: params.text },
    },
  });
}

/**
 * Sends a confirmation message with "Sí, confirmar" / "No, corregir" buttons.
 */
export async function sendConfirmationButtons(params: {
  to: string;
  phoneNumberId: string;
  apiToken: string;
  summaryText: string;
  confirmationId: string;
}): Promise<void> {
  await callWhatsAppAPI({
    phoneNumberId: params.phoneNumberId,
    apiToken: params.apiToken,
    to: params.to,
    body: {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: params.summaryText },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: `confirm_yes_${params.confirmationId}`,
                title: "✅ Sí, confirmar",
              },
            },
            {
              type: "reply",
              reply: {
                id: `confirm_no_${params.confirmationId}`,
                title: "❌ No, corregir",
              },
            },
          ],
        },
      },
    },
  });
}

/**
 * Sends a post-confirmation message with an "Undo" button after saving.
 */
export async function sendPostConfirmationButtons(params: {
  to: string;
  phoneNumberId: string;
  apiToken: string;
  summaryText: string;
  transactionId: string;
}): Promise<void> {
  await callWhatsAppAPI({
    phoneNumberId: params.phoneNumberId,
    apiToken: params.apiToken,
    to: params.to,
    body: {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: params.summaryText },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: `undo_${params.transactionId}`,
                title: "❌ Deshacer",
              },
            },
          ],
        },
      },
    },
  });
}

/**
 * Sends a list message for field selection during correction flow.
 */
export async function sendFieldSelectionList(params: {
  to: string;
  phoneNumberId: string;
  apiToken: string;
  confirmationId: string;
  fields: Array<{ id: string; title: string; description: string }>;
}): Promise<void> {
  const rows = params.fields.map((field) => ({
    id: `field_${field.id}_${params.confirmationId}`.slice(0, 200),
    title: field.title,
    description: field.description,
  }));

  await callWhatsAppAPI({
    phoneNumberId: params.phoneNumberId,
    apiToken: params.apiToken,
    to: params.to,
    body: {
      type: "interactive",
      interactive: {
        type: "list",
        header: { type: "text", text: "¿Qué dato es incorrecto?" },
        body: { text: "Seleccioná el campo que querés corregir:" },
        action: {
          button: "Ver campos",
          sections: [
            {
              title: "Campos",
              rows,
            },
          ],
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Summary builders (for confirmation messages)
// ---------------------------------------------------------------------------

const TYPE_DISPLAY: Record<TransactionType, string> = {
  expense: "Gasto",
  income: "Ingreso",
  transfer: "Transferencia",
};

const FREQUENCY_DISPLAY: Record<string, string> = {
  monthly: "Mensual",
  annual: "Anual",
  weekly: "Semanal",
};

function formatARS(amount: number): string {
  return amount.toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
  });
}

/**
 * Builds a summary text for transaction confirmation.
 */
export function buildTransactionSummary(data: ParsedTransactionData): string {
  return [
    `¿Registramos este movimiento?\n`,
    `💸 *Tipo:* ${TYPE_DISPLAY[data.type]}`,
    `💰 *Monto:* ${formatARS(data.amount)}`,
    `💵 *Moneda:* ARS`,
    `🏦 *Cuenta:* ${data.account}`,
    `📝 *Descripción:* ${data.description}`,
    `🏷️ *Categoría:* ${data.category}`,
  ].join("\n");
}

/**
 * Builds a summary text for subscription confirmation.
 */
export function buildSubscriptionSummary(data: ParsedSubscription): string {
  return [
    `¿Registramos esta suscripción?\n`,
    `🔄 *Servicio:* ${data.service_name}`,
    `💰 *Monto:* ${formatARS(data.amount)}`,
    `📅 *Frecuencia:* ${FREQUENCY_DISPLAY[data.frequency] ?? data.frequency}`,
    `🏦 *Cuenta:* ${data.account}`,
  ].join("\n");
}

/**
 * Builds the field list for transaction correction flow.
 */
export function buildFieldList(
  data: ParsedTransactionData,
): Array<{ id: string; title: string; description: string }> {
  return [
    { id: "type", title: "Tipo", description: `Actualmente: ${TYPE_DISPLAY[data.type]}` },
    { id: "amount", title: "Monto", description: `Actualmente: ${formatARS(data.amount)}` },
    { id: "currency", title: "Moneda", description: "Actualmente: ARS" },
    { id: "account", title: "Cuenta", description: `Actualmente: ${data.account}` },
    { id: "description", title: "Descripción", description: `Actualmente: ${data.description}` },
    { id: "category", title: "Categoría", description: `Actualmente: ${data.category}` },
  ];
}

/**
 * Builds the field list for subscription correction flow.
 */
export function buildSubscriptionFieldList(
  data: ParsedSubscription,
): Array<{ id: string; title: string; description: string }> {
  return [
    { id: "service_name", title: "Servicio", description: `Actualmente: ${data.service_name}` },
    { id: "frequency", title: "Frecuencia", description: `Actualmente: ${FREQUENCY_DISPLAY[data.frequency] ?? data.frequency}` },
    { id: "amount", title: "Monto", description: `Actualmente: ${formatARS(data.amount)}` },
  ];
}
