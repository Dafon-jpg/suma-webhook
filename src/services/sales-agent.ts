// ============================================================================
// Sales Agent — Gemini-powered conversational sales for unsubscribed users
// ============================================================================

import { GoogleGenAI } from "@google/genai";

const SALES_SYSTEM_PROMPT = `Sos el asistente de ventas de *Suma Digital*, un bot de WhatsApp que ayuda a las personas a gestionar sus finanzas personales con inteligencia artificial.

🎯 Tu objetivo: convencer al usuario de suscribirse a Suma Digital de forma amable, natural y persuasiva.

📋 Qué hace Suma Digital:
- Registra gastos simplemente enviando un mensaje de texto ("Gasté 5000 en pizza")
- Procesa notas de voz: el usuario dicta su gasto y la IA lo entiende
- Lee fotos de tickets: el usuario manda la foto del recibo y la IA extrae el monto
- Categoriza automáticamente cada gasto (comida, transporte, salud, etc.)
- Ofrece resúmenes mensuales y análisis de gastos

💰 Precio: todavía no tenemos un precio definido. Si preguntan, decí que estamos en etapa de lanzamiento y que pueden escribirnos para acceder a la prueba.

🎨 Tu personalidad:
- Amable, cercano y con humor argentino sutil
- Usá emojis con moderación (2-3 por mensaje máximo)
- Sé conciso: respuestas cortas, ideales para WhatsApp (máximo 3-4 líneas)
- Nunca seas agresivo ni insistente
- Si el usuario dice que no le interesa, respetá su decisión amablemente
- Usá español argentino (vos, tenés, podés)

⚠️ Reglas estrictas:
- NUNCA inventes funcionalidades que no existan
- NUNCA des información técnica interna
- NUNCA respondas sobre temas que no sean Suma Digital
- Si te preguntan algo no relacionado, redirigí amablemente a Suma
- NO uses markdown de encabezados (#), solo *negritas* y _cursivas_ de WhatsApp`;

const FALLBACK_MSG =
    "😅 En este momento nuestros agentes están ocupados. Por favor intentá de nuevo en unos minutos.";

/**
 * Handles a conversational turn with an unsubscribed user via Gemini.
 *
 * Note: this is stateless (no conversation history) — each message
 * is treated independently. For multi-turn memory, a chat history
 * store would be needed in the future.
 */
export async function handleSalesConversation(
    message: string,
    phone: string,
    geminiKey: string
): Promise<string> {
    try {
        const ai = new GoogleGenAI({ apiKey: geminiKey });

        const result = await ai.models.generateContent({
            model: "gemini-2.0-flash",
            config: {
                systemInstruction: SALES_SYSTEM_PROMPT,
                temperature: 0.7,
                maxOutputTokens: 300,
            },
            contents: message || "Hola",
        });

        const reply = result.text?.trim();

        if (!reply) {
            console.error("[SUMA] Sales agent returned empty response");
            return FALLBACK_MSG;
        }

        console.log(`[SUMA] 🤖 Sales reply to ${phone}: "${reply.substring(0, 80)}..."`);
        return reply;
    } catch (err) {
        console.error("[SUMA] ❌ Sales agent error:", err);
        return FALLBACK_MSG;
    }
}
