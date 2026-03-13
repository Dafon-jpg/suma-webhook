// ============================================================================
// Text Parser — Direct Gemini structured output for text messages
//
// Strategy: Text → Gemini with responseSchema → ParsedIntent
// This is the core parser. Audio and Image parsers delegate to this
// after extracting text from their respective media.
// ============================================================================

import type { ParsedIntent } from "../../types/index.js";
import { GoogleGenAI } from "@google/genai";
import {
    SYSTEM_PROMPT,
    TRANSACTION_RESPONSE_SCHEMA,
    buildContextMessage,
    postProcessIntent,
} from "./shared.js";
import type { ParseOptions } from "./shared.js";

console.log("[SUMA:TEXT] ✅ text-parser module loaded");

// ---------------------------------------------------------------------------
// Main entry point — parse a text message
// ---------------------------------------------------------------------------

export async function parseText(
    message: string,
    geminiKey: string,
    geminiModel: string,
    options?: ParseOptions,
): Promise<ParsedIntent> {
    const contextMessage = buildContextMessage(message, options);

    try {
        const ai = new GoogleGenAI({ apiKey: geminiKey });

        const result = await ai.models.generateContent({
            model: geminiModel,
            config: {
                systemInstruction: SYSTEM_PROMPT,
                temperature: 0,
                responseMimeType: "application/json",
                responseSchema: TRANSACTION_RESPONSE_SCHEMA,
            },
            contents: [{ role: "user", parts: [{ text: contextMessage }] }],
        });

        const raw = result.text ?? "";
        const parsed: ParsedIntent = JSON.parse(raw);

        return postProcessIntent(parsed);
    } catch (err) {
        console.error("[SUMA:TEXT] ❌ LLM parsing failed:", err);
        return {
            intent: "unknown",
            transaction_data: null,
            subscription_data: null,
            reply_message: "🤔 No entendí tu mensaje. Probá con algo como: _\"Gasté 5000 en pizza\"_",
        };
    }
}
