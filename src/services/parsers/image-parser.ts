// ============================================================================
// Image Parser — Two-step pipeline: Extract text → Text Parse
//
// Strategy:
//   1. Download image from WhatsApp
//   2. Send image to Gemini WITHOUT schema (extract receipt/ticket data)
//   3. Parse the extracted text with text-parser (structured output)
//
// Separating extraction from parsing avoids schema conflicts with
// vision and makes each step independently debuggable.
// ============================================================================

import type { ParsedIntent } from "../../types/index.js";
import { GoogleGenAI } from "@google/genai";
import { downloadWhatsAppMedia } from "../whatsapp-media.js";
import { parseText } from "./text-parser.js";
import type { ParseOptions } from "./shared.js";

console.log("[SUMA:IMAGE] ✅ image-parser module loaded");

// ---------------------------------------------------------------------------
// Image extraction prompt — get structured text from receipt/ticket
// ---------------------------------------------------------------------------

const IMAGE_EXTRACTION_PROMPT = `Analizá esta imagen. Si es un ticket, recibo, factura o comprobante de pago:
- Extraé el total/monto pagado
- Extraé el comercio o descripción
- Extraé la fecha si es visible
- Extraé el medio de pago si es visible
Respondé en formato natural, por ejemplo: "Gastó 5000 en Carrefour con tarjeta de débito"

Si NO es un ticket/recibo, describí brevemente qué se ve en la imagen.
Solo texto, sin formato ni markdown.`;

// ---------------------------------------------------------------------------
// Main entry point — parse an image message
// ---------------------------------------------------------------------------

export async function parseImage(
    imageId: string,
    apiToken: string,
    geminiKey: string,
    geminiModel: string,
    caption?: string,
    options?: ParseOptions,
): Promise<ParsedIntent> {
    const totalStart = Date.now();

    try {
        // Step 1: Download image from WhatsApp
        const downloadStart = Date.now();
        const media = await downloadWhatsAppMedia(imageId, apiToken);
        const downloadMs = Date.now() - downloadStart;
        console.log(`[SUMA:IMAGE] 📥 Downloaded in ${downloadMs}ms (${media.mimeType}, ${media.data.length} bytes)`);

        // Step 2: Extract text/data from image with Gemini (no schema)
        const extractStart = Date.now();
        const ai = new GoogleGenAI({ apiKey: geminiKey });

        const parts = [
            {
                inlineData: {
                    data: media.data.toString("base64"),
                    mimeType: media.mimeType,
                },
            },
            { text: caption
                ? `${IMAGE_EXTRACTION_PROMPT}\n\nEl usuario agregó este texto: "${caption}"`
                : IMAGE_EXTRACTION_PROMPT
            },
        ];

        const extractionResult = await ai.models.generateContent({
            model: geminiModel,
            config: {
                temperature: 0,
            },
            contents: [{ role: "user", parts }],
        });

        const extractedText = extractionResult.text?.trim() ?? "";
        const extractMs = Date.now() - extractStart;
        console.log(`[SUMA:IMAGE] 🖼️ Extracted in ${extractMs}ms: "${extractedText.slice(0, 100)}"`);

        if (!extractedText) {
            console.log("[SUMA:IMAGE] ⚠️ No text extracted from image");
            return {
                intent: "unknown",
                transaction_data: null,
                subscription_data: null,
                reply_message: "🖼️ No pude leer la imagen. ¿Podés sacar otra foto más clara o escribir el monto?",
            };
        }

        // Step 3: Parse extracted text with text-parser
        const parsed = await parseText(extractedText, geminiKey, geminiModel, options);

        const totalMs = Date.now() - totalStart;
        console.log(`[SUMA:IMAGE] ✅ Total pipeline: ${totalMs}ms (download: ${downloadMs}ms, extract: ${extractMs}ms)`);

        return parsed;
    } catch (err) {
        const totalMs = Date.now() - totalStart;
        console.error(`[SUMA:IMAGE] ❌ Image parsing failed after ${totalMs}ms:`, err);
        return {
            intent: "unknown",
            transaction_data: null,
            subscription_data: null,
            reply_message: "🖼️ No pude procesar la imagen. ¿Podés intentar de nuevo o escribir el monto?",
        };
    }
}
