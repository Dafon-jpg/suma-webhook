// ============================================================================
// Shared Types — Suma Financial Assistant
//
// Sección 2: Ledger model (accounts + transactions)
// Sección 3: Intent router & transaction parser
// Fase 1: Subscriptions, chat sessions, pending confirmations
// ============================================================================

// ---------------------------------------------------------------------------
// Transaction & Account enums
// ---------------------------------------------------------------------------

export type TransactionType = "income" | "expense" | "transfer";

export type AccountType = "cash" | "bank" | "digital_wallet" | "credit_card";

// ---------------------------------------------------------------------------
// Intent Router enums (Sección 3 + Fase 1)
// ---------------------------------------------------------------------------

export type IntentType =
  | "record_transaction"
  | "subscription"
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
  deleted_at?: string | null;              // Soft delete (undo)
  created_at?: string;
}

/** Row in the `subscriptions` table */
export interface SubscriptionRow {
  id: string;
  user_id: string;
  account_id: string;
  service_name: string;
  amount: number;
  currency: string;
  frequency: string;
  next_payment_at: string;
  category_id: string | null;
  notes: string | null;
  is_active: boolean;
  cancelled_at: string | null;
  created_at: string;
}

/** Row in the `pending_confirmations` table */
export interface PendingConfirmationRow {
  id: string;
  user_id: string;
  transaction_data: ParsedTransactionData | ParsedSubscription;
  confirmation_type: "transaction" | "subscription";
  field_editing: string | null;
  expires_at: string;
  created_at: string;
}

/** Row in the `chat_sessions` table */
export interface ChatMessage {
  id: string;
  user_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Parser output types (Sección 3)
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
 * Subscription data extracted by the LLM when intent is "subscription".
 */
export interface ParsedSubscription {
  intent: "subscription";
  service_name: string;
  amount: number;
  currency: "ARS" | "USD";
  frequency: "monthly" | "annual" | "weekly";
  account: string;
  start_date: string; // ISO date string
}

/**
 * Full structured response from the transaction parser (LLM).
 * This is the single contract between the parser and the orchestrator.
 */
export interface ParsedIntent {
  intent: IntentType;
  transaction_data: ParsedTransactionData | null;
  subscription_data?: ParsedSubscription | null;
  reply_message: string;
}

// ---------------------------------------------------------------------------
// User types
// ---------------------------------------------------------------------------

/** User info returned by upsertUser */
export interface UserInfo {
  id: string;
  name: string | null;
  isSubscribed: boolean;             // Computed: subscriptionStatus === 'active'
  subscriptionStatus: "none" | "pending" | "active" | "cancelled";
  email: string | null;
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
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
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
  GEMINI_MODEL: string;
  QSTASH_TOKEN: string;
  QSTASH_CURRENT_SIGNING_KEY: string;
  QSTASH_NEXT_SIGNING_KEY: string;
  VERCEL_URL?: string;
}
