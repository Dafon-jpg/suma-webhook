// ============================================================================
// Transaction Repository — CRUD operations against Supabase
//
// Sección 2: Replaces expense-repository.ts
// Supports income, expense, and transfer operations with accounts.
// ============================================================================

import { getSupabaseClient } from "../lib/supabase.js";
import type {
    TransactionRow,
    AccountRow,
    UserInfo,
    ParsedExpense,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// User operations (unchanged from expense-repository)
// ---------------------------------------------------------------------------

/**
 * Finds or creates a user by WhatsApp phone number.
 * Returns full UserInfo including subscription status.
 */
export async function upsertUser(
    phone: string,
    name?: string
): Promise<UserInfo> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
        .from("users")
        .upsert(
            { phone, name: name ?? null },
            { onConflict: "phone" }
        )
        .select("id, is_subscribed, email, spreadsheet_id, spreadsheet_url")
        .single();

    if (error) {
        console.error("[SUMA] Supabase user upsert error:", error);
        throw new Error(`Failed to upsert user: ${error.message}`);
    }

    return {
        id: data.id,
        isSubscribed: data.is_subscribed ?? false,
        email: data.email ?? null,
        spreadsheetId: data.spreadsheet_id ?? null,
        spreadsheetUrl: data.spreadsheet_url ?? null,
    };
}

// ---------------------------------------------------------------------------
// Category operations (unchanged)
// ---------------------------------------------------------------------------

/**
 * Resolves a category name to its UUID. Creates if it doesn't exist.
 */
export async function resolveCategoryId(categoryName: string): Promise<string> {
    const supabase = getSupabaseClient();

    const { data: existing } = await supabase
        .from("categories")
        .select("id")
        .eq("name", categoryName)
        .single();

    if (existing) return existing.id as string;

    const { data: created, error } = await supabase
        .from("categories")
        .insert({ name: categoryName })
        .select("id")
        .single();

    if (error) {
        throw new Error(`Failed to create category "${categoryName}": ${error.message}`);
    }

    return created!.id as string;
}

// ---------------------------------------------------------------------------
// Account operations (NEW)
// ---------------------------------------------------------------------------

/**
 * Gets or creates the default account for a user.
 * Every user gets a "General" cash account on first use.
 * Returns the account UUID.
 */
export async function ensureDefaultAccount(userId: string): Promise<string> {
    const supabase = getSupabaseClient();

    // Try to find existing default account
    const { data: existing } = await supabase
        .from("accounts")
        .select("id")
        .eq("user_id", userId)
        .eq("is_default", true)
        .single();

    if (existing) return existing.id as string;

    // Create default "General" account
    const { data: created, error } = await supabase
        .from("accounts")
        .insert({
            user_id: userId,
            name: "General",
            type: "cash",
            currency: "ARS",
            is_default: true,
        })
        .select("id")
        .single();

    if (error) {
        // Handle race condition: another request might have created it
        if (error.code === "23505") {
            const { data: retry } = await supabase
                .from("accounts")
                .select("id")
                .eq("user_id", userId)
                .eq("is_default", true)
                .single();

            if (retry) return retry.id as string;
        }
        throw new Error(`Failed to create default account: ${error.message}`);
    }

    return created!.id as string;
}

/**
 * Lists all accounts for a user.
 */
export async function getUserAccounts(userId: string): Promise<AccountRow[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
        .from("accounts")
        .select("*")
        .eq("user_id", userId)
        .order("is_default", { ascending: false })
        .order("name");

    if (error) {
        throw new Error(`Failed to fetch accounts: ${error.message}`);
    }

    return data as AccountRow[];
}

// ---------------------------------------------------------------------------
// Transaction operations (replaces insertExpense)
// ---------------------------------------------------------------------------

/**
 * Inserts a new transaction into the `transactions` table.
 * Returns the full inserted row.
 */
export async function insertTransaction(
    transaction: Omit<TransactionRow, "id" | "created_at">
): Promise<TransactionRow> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
        .from("transactions")
        .insert(transaction)
        .select()
        .single();

    if (error) {
        console.error("[SUMA] Supabase transaction insert error:", error);
        throw new Error(`Failed to save transaction: ${error.message}`);
    }

    return data as TransactionRow;
}

/**
 * Bridge function: takes old ParsedExpense output and saves it as a transaction.
 * This is the main function called by process-message.ts during the transition
 * period while the parser still returns ParsedExpense.
 *
 * Automatically:
 *  - Sets type to 'expense'
 *  - Assigns the user's default account
 *  - Resolves the category
 */
export async function saveExpenseAsTransaction(params: {
    userId: string;
    parsed: ParsedExpense;
    rawMessage: string;
}): Promise<TransactionRow> {
    const { userId, parsed, rawMessage } = params;

    // Resolve account and category in parallel
    const [accountId, categoryId] = await Promise.all([
        ensureDefaultAccount(userId),
        resolveCategoryId(parsed.category),
    ]);

    return insertTransaction({
        user_id: userId,
        type: "expense",
        amount: parsed.amount,
        description: parsed.description,
        category_id: categoryId,
        account_id: accountId,
        is_recurrent: false,
        raw_message: rawMessage,
    });
}

// ---------------------------------------------------------------------------
// Backward compatibility — @deprecated
// ---------------------------------------------------------------------------

/**
 * @deprecated Use saveExpenseAsTransaction instead.
 * Kept temporarily so old code paths don't break during migration.
 */
export async function insertExpense(expense: {
    user_id: string;
    amount: number;
    description: string;
    category_id: string;
    raw_message?: string;
}): Promise<TransactionRow> {
    const accountId = await ensureDefaultAccount(expense.user_id);

    return insertTransaction({
        user_id: expense.user_id,
        type: "expense",
        amount: expense.amount,
        description: expense.description,
        category_id: expense.category_id,
        account_id: accountId,
        is_recurrent: false,
        raw_message: expense.raw_message ?? null,
    });
}