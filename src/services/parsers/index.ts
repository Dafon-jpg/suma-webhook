// ============================================================================
// Parsers — Barrel Export
//
// Three independent parsers, each with its own strategy:
//   - Text:  Direct Gemini structured output
//   - Audio: Transcribe → Text parse (two-step, avoids timeout)
//   - Image: Extract text from receipt → Text parse (two-step)
// ============================================================================

export { parseText } from "./text-parser.js";
export { parseAudio } from "./audio-parser.js";
export { parseImage } from "./image-parser.js";
export type { ParseOptions } from "./shared.js";
