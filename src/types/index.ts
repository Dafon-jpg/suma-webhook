// ============================================================================
// SUMA - WhatsApp Expense Tracker
// Types & Interfaces
// ============================================================================

/** Represents a parsed expense from a user message */
export interface ParsedExpense {
  amount: number;
  description: string;
  category: string;
}

/** Row shape matching the Supabase `expenses` table */
export interface ExpenseRow {
  user_id: string;
  amount: number;
  description: string;
  category_id: string;
  raw_message: string;
  created_at?: string;
}

/** Subset of the WhatsApp Cloud API webhook payload we care about */
export interface WhatsAppWebhookBody {
  object: string;
  entry: WhatsAppEntry[];
}

export interface WhatsAppEntry {
  id: string;
  changes: WhatsAppChange[];
}

export interface WhatsAppChange {
  value: {
    messaging_product: string;
    metadata: {
      display_phone_number: string;
      phone_number_id: string;
    };
    contacts?: WhatsAppContact[];
    messages?: WhatsAppMessage[];
    statuses?: unknown[];
  };
  field: string;
}

export interface WhatsAppContact {
  profile: { name: string };
  wa_id: string;
}

export interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  text?: { body: string };
  type: string;
}

/** Shape of the category lookup table in Supabase */
export interface CategoryRow {
  id: string;
  name: string;
  keywords: string[];
}

/** Config object for environment variables (validated at startup) */
export interface AppConfig {
  WHATSAPP_VERIFY_TOKEN: string;
  WHATSAPP_API_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GEMINI_API_KEY?: string; // Optional: only if using LLM parsing
}
