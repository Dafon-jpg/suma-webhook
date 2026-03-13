// ============================================================================
// Shared constants for all parsers — Schema, System Prompt, Helpers
//
// DRY: Text, Audio, and Image parsers all share these definitions.
// ============================================================================

import type {
    ParsedIntent,
    ParsedSubscription,
    ChatMessage,
} from "../../types/index.js";

// ---------------------------------------------------------------------------
// Parse options — context injected into the prompt
// ---------------------------------------------------------------------------

export interface ParseOptions {
    userName?: string;
    subscriptionStatus?: string;
    monthlyTxCount?: number;
    conversationHistory?: ChatMessage[];
}

// ---------------------------------------------------------------------------
// Gemini Structured Output Schema
// ---------------------------------------------------------------------------

export const TRANSACTION_RESPONSE_SCHEMA = {
    type: "OBJECT",
    properties: {
        intent: {
            type: "STRING",
            enum: ["record_transaction", "subscription", "query", "system_command", "unknown"],
            description: "Classified intent of the user message",
        },
        transaction_data: {
            type: "OBJECT",
            description: "Only populated when intent is record_transaction",
            nullable: true,
            properties: {
                type: {
                    type: "STRING",
                    enum: ["income", "expense", "transfer"],
                    description: "Type of financial transaction",
                },
                amount: {
                    type: "NUMBER",
                    description: "Transaction amount as a positive number",
                },
                description: {
                    type: "STRING",
                    description: "Brief description of the transaction",
                },
                category: {
                    type: "STRING",
                    description: "Inferred category (comida, transporte, supermercado, entretenimiento, salud, educacion, servicios, ropa, sueldo, freelance, regalo, alquiler_cobrado, venta, dividendos, reembolso, otros, otros_ingresos)",
                },
                account: {
                    type: "STRING",
                    description: "Payment method or account (Efectivo, MercadoPago, Banco, Tarjeta)",
                },
            },
            required: ["type", "amount", "description", "category", "account"],
        },
        subscription_data: {
            type: "OBJECT",
            description: "Only populated when intent is subscription",
            nullable: true,
            properties: {
                service_name: {
                    type: "STRING",
                    description: "Name of the recurring service (Netflix, Spotify, gym, etc.)",
                },
                amount: {
                    type: "NUMBER",
                    description: "Subscription amount as a positive number (0 if unknown)",
                },
                currency: {
                    type: "STRING",
                    enum: ["ARS", "USD"],
                    description: "Currency of the subscription",
                },
                frequency: {
                    type: "STRING",
                    enum: ["weekly", "monthly", "annual"],
                    description: "Payment frequency",
                },
                account: {
                    type: "STRING",
                    description: "Payment method or account",
                },
                start_date: {
                    type: "STRING",
                    description: "ISO date (YYYY-MM-DD), default today",
                },
            },
            required: ["service_name", "amount", "currency", "frequency", "account", "start_date"],
        },
        reply_message: {
            type: "STRING",
            description: "Friendly reply in Argentine Spanish for non-transaction intents, or a confirmation hint",
        },
    },
    required: ["intent", "transaction_data", "subscription_data", "reply_message"],
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `Sos SUMA, un asistente financiero personal por WhatsApp para usuarios argentinos.
Analizá cada mensaje y clasificalo en UNA intención:

1. "record_transaction" → Registrar ingreso, gasto o transferencia.
   - Extraé: tipo (income/expense/transfer), monto, descripción, categoría, cuenta.
   - Cobró/le pagaron/facturó/entró plata → "income". Gastó/pagó/compró → "expense". Transfirió/movió entre cuentas → "transfer".
   - Sin cuenta mencionada → "Efectivo". Sin claridad ingreso/egreso → elegí el más probable.
   - Categorías: comida, transporte, supermercado, entretenimiento, salud, educacion, servicios, ropa, sueldo, freelance, regalo, alquiler_cobrado, venta, dividendos, reembolso, otros, otros_ingresos.
   - Monto SIEMPRE positivo. "5.000,50"=5000.50, "5k"=5000, "250 lucas"=250000.

2. "subscription" → Suscripción o servicio recurrente (Netflix, Spotify, gym, etc.).
   - Extraé: servicio, monto, frecuencia (monthly default), cuenta, start_date (hoy ISO default).
   - Monto 0 si no lo dice.

3. "query" → Pregunta sobre finanzas. Respondé amablemente en reply_message.

4. "system_command" → Acción: "ayuda"→explicá brevemente; "deshacer"/"borrar el último"→reply "undo"; otros→respondé útilmente.

5. "unknown" → Sin relación con finanzas. Respondé amigablemente, recordá que sos asistente financiero.

REGLAS:
- Audio incomprensible → "unknown", pedí que repita.
- Foto de ticket/recibo → extraé total como "expense".
- transaction_data null si intent ≠ "record_transaction".
- subscription_data null si intent ≠ "subscription".
- reply_message siempre con valor.
- Español argentino informal (vos, dale, tenés).`;

// ---------------------------------------------------------------------------
// Context builder — injects user info + history into the message
// ---------------------------------------------------------------------------

export function buildContextMessage(message: string, options?: ParseOptions): string {
    if (!options) return message;

    const parts: string[] = [];

    parts.push("[Contexto del usuario]");
    parts.push(`Nombre: ${options.userName ?? "No registrado"}`);
    parts.push(`Suscripción: ${options.subscriptionStatus ?? "none"}`);
    parts.push(`Transacciones este mes: ${options.monthlyTxCount ?? 0}`);

    if (options.conversationHistory && options.conversationHistory.length > 0) {
        parts.push("");
        parts.push("[Historial reciente]");
        for (const msg of options.conversationHistory) {
            const label = msg.role === "user" ? "Usuario" : "Suma";
            parts.push(`${label}: ${msg.content}`);
        }
    }

    parts.push("");
    parts.push("[Mensaje actual]");
    parts.push(message);

    return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Post-processing — enforces nullability and validates parsed output
// ---------------------------------------------------------------------------

export function postProcessIntent(parsed: ParsedIntent): ParsedIntent {
    // Enforce nullability rules
    if (parsed.intent !== "record_transaction") {
        parsed.transaction_data = null;
    }

    if (parsed.intent !== "subscription") {
        parsed.subscription_data = null;
    }

    // Add required `intent` field to subscription_data (not in Gemini schema)
    if (parsed.intent === "subscription" && parsed.subscription_data) {
        (parsed.subscription_data as ParsedSubscription).intent = "subscription";
    }

    // Validate amount for transactions
    if (parsed.transaction_data && parsed.transaction_data.amount <= 0) {
        return {
            intent: "unknown",
            transaction_data: null,
            subscription_data: null,
            reply_message: "🤔 No pude identificar un monto válido. ¿Podés repetirlo con el monto?",
        };
    }

    return parsed;
}
