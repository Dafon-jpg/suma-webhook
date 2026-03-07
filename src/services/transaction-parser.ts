// ============================================================================
// Transaction Parser — Intent Router + Structured Output (Sección 3)
//
// Strategy:
//   1. Build context string (user info + conversation history + message)
//   2. Call Gemini with structured output schema
//   3. Return ParsedIntent with transaction_data or subscription_data
//
// Uses `responseSchema` to enforce a strict JSON contract.
// ============================================================================

import type {
    ParsedIntent,
    ParsedSubscription,
    MediaContent,
    ChatMessage,
} from "../types/index.js";
import { GoogleGenAI } from "@google/genai";
import type { Part } from "@google/genai";

// Diagnostic — if you don't see this, the module crashed on import
console.log("[SUMA] ✅ transaction-parser module loaded");

// ---------------------------------------------------------------------------
// Parse options — context injected into the prompt
// ---------------------------------------------------------------------------

interface ParseOptions {
    media?: MediaContent;
    userName?: string;
    subscriptionStatus?: string;
    monthlyTxCount?: number;
    conversationHistory?: ChatMessage[];
}

// ---------------------------------------------------------------------------
// Gemini Structured Output Schema
// ---------------------------------------------------------------------------

const TRANSACTION_RESPONSE_SCHEMA = {
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

const SYSTEM_PROMPT = `Sos SUMA, un asistente financiero personal por WhatsApp para usuarios argentinos.
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

function buildContextMessage(message: string, options?: ParseOptions): string {
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
// LLM-based parser — Gemini with Structured Outputs
// ---------------------------------------------------------------------------

async function parseWithLLM(
    contextMessage: string,
    geminiKey: string,
    media?: MediaContent,
): Promise<ParsedIntent> {
    const ai = new GoogleGenAI({ apiKey: geminiKey });

    const parts: Part[] = [];

    if (media) {
        parts.push({
            inlineData: {
                data: media.data.toString("base64"),
                mimeType: media.mimeType,
            },
        });
    }

    parts.push({
        text: contextMessage || "Analizá el contenido multimedia adjunto.",
    });

    const result = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        config: {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: TRANSACTION_RESPONSE_SCHEMA,
        },
        contents: [{ role: "user", parts }],
    });

    const raw = result.text ?? "";
    const parsed: ParsedIntent = JSON.parse(raw);

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

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function parseTransaction(
    message: string,
    geminiKey: string,
    options?: ParseOptions,
): Promise<ParsedIntent> {
    const contextMessage = buildContextMessage(message, options);

    try {
        return await parseWithLLM(contextMessage, geminiKey, options?.media);
    } catch (err) {
        const label = options?.media ? "media" : "text";
        console.error(`[SUMA] ❌ LLM parsing failed for ${label}:`, err);

        return {
            intent: "unknown",
            transaction_data: null,
            subscription_data: null,
            reply_message: options?.media
                ? "🤔 No pude procesar ese contenido. Probá enviándolo de nuevo."
                : "🤔 No entendí tu mensaje. Probá con algo como: _\"Gasté 5000 en pizza\"_",
        };
    }
}
