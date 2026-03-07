// ============================================================================
// Config loader — fails fast if required env vars are missing
// ============================================================================

import type { AppConfig } from "../types/index.js";

const REQUIRED_VARS = [
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_API_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_APP_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "QSTASH_TOKEN",
  "QSTASH_CURRENT_SIGNING_KEY",
  "QSTASH_NEXT_SIGNING_KEY",
] as const;

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `[SUMA] Missing required env vars: ${missing.join(", ")}`
    );
  }

  cached = {
    WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN!,
    WHATSAPP_API_TOKEN: process.env.WHATSAPP_API_TOKEN!,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID!,
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET!,
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    QSTASH_TOKEN: process.env.QSTASH_TOKEN!,
    QSTASH_CURRENT_SIGNING_KEY: process.env.QSTASH_CURRENT_SIGNING_KEY!,
    QSTASH_NEXT_SIGNING_KEY: process.env.QSTASH_NEXT_SIGNING_KEY!,
  };

  return cached;
}
