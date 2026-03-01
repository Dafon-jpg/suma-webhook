// ============================================================================
// Shared Types — Suma Financial Assistant
//
// Sección 2: Ledger model (accounts + transactions)
// Sección 3: Intent router & transaction parser
// ============================================================================

// ---------------------------------------------------------------------------
// Transaction & Account enums
// ---------------------------------------------------------------------------

export type TransactionType = "income" | "expense" | "transfer";

export type AccountType = "cash" | "bank" | "digital_wallet" | "credit_card";

// ---------------------------------------------------------------------------
// Intent Router enums (Sección 3)
// ---------------------------------------------------------------------------

export type IntentType =
  | "record_transaction"
  | "query"
  | "system_command"
  | "unknown";

// ---------------------------------------------------------------------------
// Database row types (match Supabase schema exactly)
// ---------------------------------------------------------------------------

/** Row in the `accounts` table */
export interface AccountRow {
  id: string;          // UUID
  user_id: string;
  name: string;        // "Efectivo", "MercadoPago", "Banco Galicia"
  type: AccountType;
  currency: string;    // "ARS"
  balance: number;
  is_default: boolean;
  created_at?: string;
}

/** Row in the `transactions` table */
export interface TransactionRow {
  id?: string;         // UUID, auto-generated on insert
  user_id: string;
  type: TransactionType;
  amount: number;
  description: string;
  category_id: string | null;
  account_id: string;
  destination_account_id?: string | null;  // Only for transfers
  is_recurrent: boolean;
  installment_current?: number | null;
  installment_total?: number | null;
  raw_message?: string | null;
  created_at?: string;
}

// ---------------------------------------------------------------------------
// Parser output types (Sección 3 — replaces ParsedExpense)
// ---------------------------------------------------------------------------

/**
 * Transaction data extracted by the LLM when intent is "record_transaction".
 * This is the structured output the parser returns for financial operations.
 */
export interface ParsedTransactionData {
  type: TransactionType;
  amount: number;
  description: string;
  category: string;
  account: string;
}

/**
 * Full structured response from the transaction parser (LLM or regex+wrapper).
 * This is the single contract between the parser and the orchestrator.
 */
export interface ParsedIntent {
  intent: IntentType;
  transaction_data: ParsedTransactionData | null;
  reply_message: string;
}

/**
 * @deprecated Use ParsedTransactionData instead.
 * Kept for backward compatibility during migration (regex parser still uses this shape).
 */
export interface ParsedExpense {
  amount: number;
  description: string;
  category: string;
}

/**
 * @deprecated Use TransactionRow instead.
 */
export interface ExpenseRow {
  user_id: string;
  amount: number;
  description: string;
  category_id: string;
  raw_message?: string;
}

// ---------------------------------------------------------------------------
// User types
// ---------------------------------------------------------------------------

/** User info returned by upsertUser */
export interface UserInfo {
  id: string;
  isSubscribed: boolean;
  email: string | null;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
}

// ---------------------------------------------------------------------------
// Media types
// ---------------------------------------------------------------------------

/** Downloaded media content (audio/image from WhatsApp) */
export interface MediaContent {
  data: Buffer;
  mimeType: string;
}

// ---------------------------------------------------------------------------
// WhatsApp webhook payload types
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
  value: WhatsAppChangeValue;
  field: string;
}

export interface WhatsAppChangeValue {
  messaging_product: string;
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
  statuses?: unknown[];
}

export interface WhatsAppContact {
  profile: { name: string };
  wa_id: string;
}

export interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: "text" | "audio" | "image" | "document" | "sticker" | "reaction" | "interactive";
  text?: { body: string };
  audio?: { id: string; mime_type: string };
  image?: { id: string; mime_type: string; caption?: string };
}

export interface QueuedMessagePayload {
  message: WhatsAppMessage;
  contacts?: WhatsAppContact[];
  metadata: {
    phone_number_id: string;
    display_phone_number: string;
  };
  receivedAt: string;
}

// ---------------------------------------------------------------------------
// App configuration
// ---------------------------------------------------------------------------

export interface AppConfig {
  WHATSAPP_API_TOKEN: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_VERIFY_TOKEN: string;
  WHATSAPP_APP_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GEMINI_API_KEY?: string;
  QSTASH_TOKEN: string;
  QSTASH_CURRENT_SIGNING_KEY: string;
  QSTASH_NEXT_SIGNING_KEY: string;
  VERCEL_URL?: string;
}