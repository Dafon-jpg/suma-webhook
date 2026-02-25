// ============================================================================
// Expense Parser
// Strategy: regex-first (fast & free), LLM fallback (smart & flexible)
// ============================================================================

import type { ParsedExpense, MediaContent } from "../types";
import { GoogleGenAI } from "@google/genai";
import type { Part } from "@google/genai";

// ---------------------------------------------------------------------------
// Category mapping — extensible keyword dictionary
// ---------------------------------------------------------------------------

const CATEGORY_MAP: Record<string, string[]> = {
  comida: [
    "pizza", "hamburguesa", "almuerzo", "cena", "desayuno", "comida",
    "restaurante", "sushi", "empanadas", "milanesa", "asado", "helado",
    "café", "merienda", "birra", "cerveza", "bar", "delivery", "rappi",
    "pedidosya", "mcdonalds", "burger", "pancho", "medialunas",
  ],
  transporte: [
    "uber", "cabify", "taxi", "subte", "colectivo", "bondi", "tren",
    "nafta", "combustible", "estacionamiento", "peaje", "sube",
  ],
  supermercado: [
    "super", "supermercado", "mercado", "carrefour", "dia", "coto",
    "chino", "verdulería", "almacén", "fiambrería",
  ],
  entretenimiento: [
    "cine", "netflix", "spotify", "juego", "steam", "playstation",
    "xbox", "teatro", "recital", "concierto", "salida", "boliche",
  ],
  salud: [
    "farmacia", "médico", "doctor", "dentista", "psicólogo", "terapia",
    "remedio", "medicamento", "obra social", "prepaga",
  ],
  educacion: [
    "libro", "curso", "udemy", "apunte", "fotocopia", "cuaderno",
    "universidad", "facultad", "matrícula",
  ],
  servicios: [
    "luz", "gas", "agua", "internet", "telefono", "celular", "alquiler",
    "expensas", "wifi", "cable",
  ],
  ropa: [
    "ropa", "zapatillas", "remera", "pantalón", "campera", "jean",
    "vestido", "calzado",
  ],
};

/**
 * Infers a category from the description text by matching keywords.
 * Returns "otros" if no match is found.
 */
function inferCategory(text: string): string {
  const normalize = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  const normalized = normalize(text);

  for (const [category, keywords] of Object.entries(CATEGORY_MAP)) {
    if (keywords.some((kw) => normalized.includes(normalize(kw)))) {
      return category;
    }
  }

  return "otros";
}

// ---------------------------------------------------------------------------
// Regex-based parser
// ---------------------------------------------------------------------------

/**
 * Regex patterns to capture common expense phrasing in Spanish:
 *   "gasté 5000 en pizza"
 *   "pagué $1.500,50 de luz"
 *   "5000 pizza"
 *   "uber $3200"
 *   "almuerzo 2500"
 */
const EXPENSE_PATTERNS: RegExp[] = [
  // "gasté/pagué $5.000,50 en/de pizza"
  /(?:gast[eé]|pagu[eé]|compr[eé]|puse)\s+\$?([\d.,]+)\s+(?:en|de|por)\s+(.+)/i,
  // "gasté/pagué en pizza $5000" (amount after description)
  /(?:gast[eé]|pagu[eé]|compr[eé]|puse)\s+(?:en|de|por)\s+(.+?)\s+\$?([\d.,]+)/i,
  // "$5000 en pizza" or "5000 en pizza"
  /\$?([\d.,]+)\s+(?:en|de|por)\s+(.+)/i,
  // "pizza $5000" or "pizza 5000"
  /^([a-záéíóúñ\s]+?)\s+\$?([\d.,]+)$/i,
  // "5000 pizza" (just number + description)
  /^\$?([\d.,]+)\s+([a-záéíóúñ\s]+)$/i,
];

/** Parses an Argentine-formatted number: "5.000,50" → 5000.50 */
function parseArgNumber(raw: string): number {
  // Remove dots (thousands separator in AR), replace comma with period
  const cleaned = raw.replace(/\./g, "").replace(",", ".");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Attempts to parse an expense from a user message using regex patterns.
 * Returns null if no pattern matches.
 */
export function parseExpenseRegex(message: string): ParsedExpense | null {
  const trimmed = message.trim();

  for (const pattern of EXPENSE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (!match) continue;

    let amountRaw: string;
    let description: string;

    // Patterns 0, 2, 4 have amount in group 1, description in group 2
    // Patterns 1, 3 have description in group 1, amount in group 2
    if (pattern === EXPENSE_PATTERNS[1] || pattern === EXPENSE_PATTERNS[3]) {
      description = match[1].trim();
      amountRaw = match[2];
    } else {
      amountRaw = match[1];
      description = match[2].trim();
    }

    const amount = parseArgNumber(amountRaw);

    if (amount <= 0) continue;

    return {
      amount,
      description: description.toLowerCase(),
      category: inferCategory(description),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// LLM-based parser (uses Google Gemini API)
// ---------------------------------------------------------------------------

interface LLMParsedResponse {
  amount: number;
  description: string;
  category: string;
}

const systemPrompt = `Sos un asistente que extrae datos de gastos de mensajes en español argentino.
El usuario puede enviar:
- Un mensaje de texto describiendo un gasto
- Una nota de voz (audio) dictando un gasto
- Una foto de un ticket o recibo de compra

Respondé SOLO con un JSON válido (sin markdown) con esta estructura:
{ "amount": number, "description": "string", "category": "string" }

Categorías válidas: comida, transporte, supermercado, entretenimiento, salud, educacion, servicios, ropa, otros.

Si hay varios ítems en un ticket, sumá el total.
Si no podés extraer un gasto, respondé: { "amount": 0, "description": "", "category": "" }`;

/**
 * Sends the message to Google Gemini to extract structured expense data.
 * Use this as a fallback when regex parsing fails.
 */
export async function parseExpenseLLM(
  message: string,
  geminiKey: string,
  media?: MediaContent
): Promise<ParsedExpense | null> {
  try {
    const ai = new GoogleGenAI({ apiKey: geminiKey });

    // Build multimodal parts array
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
      text: message || "Extraé el gasto de este contenido.",
    });

    const result = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      config: {
        systemInstruction: systemPrompt,
        temperature: 0,
        maxOutputTokens: 150,
      },
      contents: [{ role: "user", parts }],
    });

    const content: string = result.text ?? "";
    const parsed: LLMParsedResponse = JSON.parse(content);

    if (!parsed.amount || parsed.amount <= 0) return null;

    return {
      amount: parsed.amount,
      description: parsed.description,
      category: parsed.category || "otros",
    };
  } catch (err) {
    console.error("[SUMA] LLM parsing failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main parse function — orchestrates both strategies
// ---------------------------------------------------------------------------

/**
 * Main entry point: tries regex first, falls back to LLM if available.
 */
export async function parseExpense(
  message: string,
  geminiKey?: string,
  media?: MediaContent
): Promise<ParsedExpense | null> {
  // If media is present, skip regex — go straight to LLM
  if (media) {
    if (!geminiKey) {
      console.error("[SUMA] Cannot process media without GEMINI_API_KEY");
      return null;
    }
    return parseExpenseLLM(message, geminiKey, media);
  }

  // 1. Try fast regex parsing (text only)
  const regexResult = parseExpenseRegex(message);
  if (regexResult) return regexResult;

  // 2. Fallback to LLM if API key is configured
  if (geminiKey) {
    return parseExpenseLLM(message, geminiKey);
  }

  return null;
}
