// ============================================================================
// Audio Parser — Two-step pipeline: Transcribe → Text Parse
//
// Strategy:
//   1. Download audio from WhatsApp
//   2. Send audio to Gemini WITHOUT schema (fast transcription)
//   3. Parse the transcription with text-parser (structured output)
//
// This two-step approach avoids the timeout issue (~56s) caused by
// sending audio + structured schema together. Transcription alone
// takes ~5-10s, then text parsing ~2-3s = total ~7-13s.
// ============================================================================

import type { ParsedIntent } from "../../types/index.js";
import { GoogleGenAI } from "@google/genai";
import { downloadWhatsAppMedia } from "../whatsapp-media.js";
import { parseText } from "./text-parser.js";
import type { ParseOptions } from "./shared.js";

console.log("[SUMA:AUDIO] ✅ audio-parser module loaded");

// ---------------------------------------------------------------------------
// Transcription prompt — simple, no schema overhead
// ---------------------------------------------------------------------------

const TRANSCRIPTION_PROMPT = `Transcribí el audio exactamente como lo dice el usuario.
Si no se entiende o está vacío, respondé "INAUDIBLE".
Solo devolvé la transcripción, sin formato ni explicaciones.`;

// ---------------------------------------------------------------------------
// Timeout warning threshold (seconds)
// ---------------------------------------------------------------------------

const WARN_THRESHOLD_MS = 25_000;

// ---------------------------------------------------------------------------
// Main entry point — parse an audio message
// ---------------------------------------------------------------------------

export async function parseAudio(
    audioId: string,
    apiToken: string,
    geminiKey: string,
    geminiModel: string,
    options?: ParseOptions,
): Promise<ParsedIntent> {
    const totalStart = Date.now();

    try {
        // Step 1: Download audio from WhatsApp
        const downloadStart = Date.now();
        const media = await downloadWhatsAppMedia(audioId, apiToken);
        const downloadMs = Date.now() - downloadStart;
        console.log(`[SUMA:AUDIO] 📥 Downloaded in ${downloadMs}ms (${media.mimeType}, ${media.data.length} bytes)`);

        // Step 2: Transcribe audio with Gemini (no schema = fast)
        const transcribeStart = Date.now();
        const ai = new GoogleGenAI({ apiKey: geminiKey });

        const transcriptionResult = await ai.models.generateContent({
            model: geminiModel,
            config: {
                temperature: 0,
            },
            contents: [{
                role: "user",
                parts: [
                    {
                        inlineData: {
                            data: media.data.toString("base64"),
                            mimeType: media.mimeType,
                        },
                    },
                    { text: TRANSCRIPTION_PROMPT },
                ],
            }],
        });

        const transcription = transcriptionResult.text?.trim() ?? "";
        const transcribeMs = Date.now() - transcribeStart;
        console.log(`[SUMA:AUDIO] 🎙️ Transcribed in ${transcribeMs}ms: "${transcription.slice(0, 100)}"`);

        // Handle inaudible audio
        if (!transcription || transcription === "INAUDIBLE") {
            console.log("[SUMA:AUDIO] ⚠️ Audio inaudible or empty");
            return {
                intent: "unknown",
                transaction_data: null,
                subscription_data: null,
                reply_message: "🎙️ No pude entender el audio. ¿Podés repetirlo o escribirlo?",
            };
        }

        // Step 3: Parse transcription with text-parser
        const parsed = await parseText(transcription, geminiKey, geminiModel, options);

        const totalMs = Date.now() - totalStart;
        if (totalMs > WARN_THRESHOLD_MS) {
            console.warn(`[SUMA:AUDIO] ⚠️ Total pipeline took ${totalMs}ms (>${WARN_THRESHOLD_MS}ms threshold)`);
        } else {
            console.log(`[SUMA:AUDIO] ✅ Total pipeline: ${totalMs}ms (download: ${downloadMs}ms, transcribe: ${transcribeMs}ms)`);
        }

        return parsed;
    } catch (err) {
        const totalMs = Date.now() - totalStart;
        console.error(`[SUMA:AUDIO] ❌ Audio parsing failed after ${totalMs}ms:`, err);
        return {
            intent: "unknown",
            transaction_data: null,
            subscription_data: null,
            reply_message: "🎙️ No pude procesar el audio. ¿Podés intentar de nuevo o escribirlo?",
        };
    }
}
