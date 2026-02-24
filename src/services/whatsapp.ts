// ============================================================================
// WhatsApp Cloud API — send messages back to the user
// ============================================================================

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

/**
 * Formats a success message for the user after saving an expense.
 */
export function formatSuccessMessage(
  amount: number,
  description: string,
  category: string
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
    `🤔 No pude entender ese gasto.`,
    ``,
    `Probá con alguno de estos formatos:`,
    `• _"Gasté 5000 en pizza"_`,
    `• _"Uber $3200"_`,
    `• _"$1500 café"_`,
    ``,
    `_También podés escribir "resumen" o "ayuda"._`,
  ].join("\n");
}
