// ============================================================================
// Transaction Parser — Intent Router + Structured Output (Sección 3)
//
// Strategy:
//   1. Media present → call Gemini directly (needs multimodal)
//   2. Text + API key → call Gemini (classifies intent + extracts data)
//   3. No API key or LLM failed → return unknown
//
// Uses `responseSchema` to enforce a strict JSON contract.
// ============================================================================

import type {
    ParsedIntent,
    MediaContent,
} from "../types/index.js";
import { GoogleGenAI } from "@google/genai";
import type { Part } from "@google/genai";

// Diagnostic — if you don't see this, the module crashed on import
console.log("[SUMA] ✅ transaction-parser module loaded");

// ---------------------------------------------------------------------------
// Gemini Structured Output Schema
// ---------------------------------------------------------------------------

/**
 * JSON Schema for Gemini's `responseSchema`.
 *
 * Uses string literals ("OBJECT", "STRING", "NUMBER") instead of
 * importing the `Type` enum, for maximum compatibility across SDK versions.
 * The Gemini REST API accepts these strings directly.
 */
const TRANSACTION_RESPONSE_SCHEMA = {
    type: "OBJECT",
    properties: {
        intent: {
            type: "STRING",
            enum: ["record_transaction", "query", "system_command", "unknown"],
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
                    description: "Inferred category (comida, transporte, supermercado, entretenimiento, salud, educacion, servicios, ropa, sueldo, freelance, regalo, otros)",
                },
                account: {
                    type: "STRING",
                    description: "Payment method or account (Efectivo, MercadoPago, Banco, Tarjeta, etc.)",
                },
            },
            required: ["type", "amount", "description", "category", "account"],
        },
        reply_message: {
            type: "STRING",
            description: "Friendly reply for the user when intent is NOT record_transaction, or a confirmation hint when it is",
        },
    },
    required: ["intent", "transaction_data", "reply_message"],
};

// ---------------------------------------------------------------------------
// System prompt — instructs Gemini on how to classify and extract
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Sos SUMA, un asistente financiero personal por WhatsApp para usuarios argentinos.

Tu trabajo es analizar cada mensaje del usuario y clasificarlo en UNA de estas intenciones:

1. "record_transaction" → El usuario quiere registrar un ingreso, gasto o transferencia.
   - Extraé: tipo (income/expense/transfer), monto, descripción, categoría y cuenta.
   - Por defecto, asumí "expense" salvo que el usuario diga explícitamente que cobró, le pagaron, recibió plata, etc.
   - Si el usuario menciona un método de pago (MercadoPago, efectivo, tarjeta, débito), ponelo en "account". Si no lo menciona, usá "Efectivo".
   - Categorías válidas: comida, transporte, supermercado, entretenimiento, salud, educacion, servicios, ropa, sueldo, freelance, regalo, otros.
   - El monto SIEMPRE debe ser positivo.
   - Para transferencias, necesitás que el usuario mencione origen y destino.

2. "query" → El usuario hace una pregunta sobre sus finanzas (ej: "¿cuánto gasté este mes?", "¿cuál es mi balance?").
   - No extraigas transaction_data.
   - Respondé en reply_message con algo como: "📊 La funcionalidad de consultas estará disponible pronto. ¡Estamos trabajando en ello!"

3. "system_command" → El usuario quiere ejecutar una acción del sistema (ej: "ayuda", "borrar el último", "resumen", "configurar").
   - No extraigas transaction_data.
   - Respondé en reply_message de forma útil. Para "ayuda", explicá brevemente cómo usar el bot.

4. "unknown" → El mensaje no tiene relación con finanzas (saludos, chistes, preguntas generales).
   - No extraigas transaction_data.
   - Respondé amigablemente en reply_message, y recordale que sos un asistente financiero.

REGLAS IMPORTANTES:
- Si el mensaje es un audio transcripto que no se entiende bien, clasificá como "unknown" y pedí que lo repita.
- Si hay una foto de un ticket/recibo, extraé el total y los ítems principales.
- Los números argentinos usan punto como separador de miles y coma para decimales: "5.000,50" = 5000.50.
- Siempre respondé en español argentino informal (vos, dale, etc.).
- El campo transaction_data DEBE ser null cuando el intent NO es "record_transaction".
- El campo reply_message siempre debe tener un valor (aunque sea una confirmación breve para transacciones).`;

// ---------------------------------------------------------------------------
// LLM-based parser — Gemini with Structured Outputs
// ---------------------------------------------------------------------------

async function parseWithLLM(
    message: string,
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
        text: message || "Analizá el contenido multimedia adjunto.",
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

    if (parsed.intent !== "record_transaction") {
        parsed.transaction_data = null;
    }

    if (parsed.transaction_data && parsed.transaction_data.amount <= 0) {
        return {
            intent: "unknown",
            transaction_data: null,
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
    geminiKey?: string,
    media?: MediaContent,
): Promise<ParsedIntent> {
    if (media) {
        if (!geminiKey) {
            console.error("[SUMA] Cannot process media without GEMINI_API_KEY");
            return {
                intent: "unknown",
                transaction_data: null,
                reply_message: "⚠️ No puedo procesar archivos multimedia en este momento.",
            };
        }

        try {
            return await parseWithLLM(message, geminiKey, media);
        } catch (err) {
            console.error("[SUMA] LLM parsing failed for media:", err);
            return {
                intent: "unknown",
                transaction_data: null,
                reply_message: "🤔 No pude procesar ese contenido. Probá enviándolo de nuevo.",
            };
        }
    }

    // LLM available → always prefer it (classifies income/expense/transfer correctly)
    if (geminiKey) {
        try {
            return await parseWithLLM(message, geminiKey);
        } catch (err) {
            console.error("[SUMA] LLM parsing failed:", err);
        }
    }

    // No LLM available or LLM failed — return unknown
    return {
        intent: "unknown",
        transaction_data: null,
        reply_message: "🤔 No entendí tu mensaje. Probá con algo como: _\"Gasté 5000 en pizza\"_",
    };
}