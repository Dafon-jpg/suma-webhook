// ============================================================================
// SUMA — Types & Interfaces
// ============================================================================

// ---------------------------------------------------------------------------
// Parsed data
// ---------------------------------------------------------------------------

export interface ParsedExpense {
  amount: number;
  description: string;
  category: string;
}

// ---------------------------------------------------------------------------
// Supabase row shapes
// ---------------------------------------------------------------------------

export interface ExpenseRow {
  user_id: string;
  amount: number;
  description: string;
  category_id: string;
  raw_message: string;
  created_at?: string;
}
/** Info returned from upsertUser */
export interface UserInfo {
  id: string;
  isSubscribed: boolean;
  email: string | null;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
}

export interface CategoryRow {
  id: string;
  name: string;
  keywords: string[];
}

// ---------------------------------------------------------------------------
// WhatsApp Cloud API payload types
// ---------------------------------------------------------------------------

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
  audio?: { id: string; mime_type: string };
  image?: { id: string; mime_type: string; caption?: string };
  type: string;
}

export interface MediaContent {
  data: Buffer;
  mimeType: string;
}

// ---------------------------------------------------------------------------
// App config (env vars)
// ---------------------------------------------------------------------------

export interface AppConfig {
  WHATSAPP_VERIFY_TOKEN: string;
  WHATSAPP_API_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_APP_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GEMINI_API_KEY?: string;
  QSTASH_TOKEN: string;
  QSTASH_CURRENT_SIGNING_KEY: string;
  QSTASH_NEXT_SIGNING_KEY: string;
}

// ---------------------------------------------------------------------------
// Queue message payload (webhook → worker)
// ---------------------------------------------------------------------------

/** The payload we enqueue in QStash for the worker to process */
export interface QueuedMessagePayload {
  message: WhatsAppMessage;
  contacts?: WhatsAppContact[];
  metadata: {
    phone_number_id: string;
    display_phone_number: string;
  };
  receivedAt: string; // ISO timestamp for observability
}
