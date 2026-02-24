// ============================================================================
// Config loader — fails fast if required env vars are missing
// ============================================================================

import type { AppConfig } from "../types";

const REQUIRED_VARS = [
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_API_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export function loadConfig(): AppConfig {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `[SUMA] Missing required env vars: ${missing.join(", ")}`
    );
  }

  return {
    WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN!,
    WHATSAPP_API_TOKEN: process.env.WHATSAPP_API_TOKEN!,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID!,
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };
}
