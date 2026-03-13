// ============================================================================
// Transaction Repository — CRUD operations against Supabase
//
// Supports income, expense, and transfer operations with accounts.
// ============================================================================

import { getSupabaseClient } from "../lib/supabase.js";
import type {
    TransactionRow,
    AccountRow,
    UserInfo,
    OnboardingSource,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// User operations
// ---------------------------------------------------------------------------

/**
 * Derives how the user originally registered based on their current data.
 * - "web": has email AND active subscription (registered via suma.digital)
 * - "whatsapp": has name but no email (registered through the bot)
 * - "unknown": freshly created, no data yet
 */
function deriveOnboardingSource(
    name: string | null,
    email: string | null,
    subscriptionStatus: string,
): OnboardingSource {
    if (email !== null && subscriptionStatus === "active") return "web";
    if (name !== null) return "whatsapp";
    return "unknown";
}

/**
 * Finds or creates a user by WhatsApp phone number.
 * Returns full UserInfo including subscription status.
 */
export async function upsertUser(
    phone: string,
    name?: string
): Promise<UserInfo> {
    const supabase = getSupabaseClient();

    // Step 1: Try to find existing user
    const { data: existing } = await supabase
        .from("users")
        .select("id, name, is_subscribed, subscription_status, email")
        .eq("phone", phone)
        .single();

    if (existing) {
        // Update name only if explicitly provided
        if (name !== undefined) {
            await supabase.from("users").update({ name }).eq("id", existing.id);
            existing.name = name;
        }

        const subscriptionStatus = existing.subscription_status ?? "none";
        const isSubscribed = subscriptionStatus === "active" || existing.is_subscribed === true;

        const onboardingSource = deriveOnboardingSource(existing.name ?? null, existing.email ?? null, subscriptionStatus);
        console.log(`[SUMA] 👤 User found: ${existing.id}, subscription: ${subscriptionStatus}, isSubscribed: ${isSubscribed}, source: ${onboardingSource}`);

        return {
            id: existing.id,
            name: existing.name ?? null,
            isSubscribed,
            subscriptionStatus,
            email: existing.email ?? null,
            onboardingSource,
        };
    }

    // Step 2: User doesn't exist — create new
    const { data: created, error: insertError } = await supabase
        .from("users")
        .insert({ phone, name: name ?? null })
        .select("id, name, is_subscribed, subscription_status, email")
        .single();

    if (insertError) {
        console.error("[SUMA] Supabase user insert error:", insertError);
        throw new Error(`Failed to create user: ${insertError.message}`);
    }

    const subscriptionStatus = created.subscription_status ?? "none";
    const isSubscribed = subscriptionStatus === "active" || created.is_subscribed === true;

    const onboardingSource = deriveOnboardingSource(created.name ?? null, created.email ?? null, subscriptionStatus);
    console.log(`[SUMA] 👤 New user created: ${created.id}, subscription: ${subscriptionStatus}, source: ${onboardingSource}`);

    return {
        id: created.id,
        name: created.name ?? null,
        isSubscribed,
        subscriptionStatus,
        email: created.email ?? null,
        onboardingSource,
    };
}

// ---------------------------------------------------------------------------
// Category operations
// ---------------------------------------------------------------------------

/**
 * Resolves a category name to its UUID.
 * If userId is provided, searches user-specific categories first, then global.
 * Creates a new category if it doesn't exist (user-specific if userId is given).
 */
export async function resolveCategoryId(
    categoryName: string,
    userId?: string,
): Promise<string> {
    const supabase = getSupabaseClient();

    if (userId) {
        // Buscar categoría del usuario primero
        const { data: userCat } = await supabase
            .from("categories")
            .select("id")
            .eq("name", categoryName)
            .eq("user_id", userId)
            .single();

        if (userCat) return userCat.id as string;

        // Buscar categoría global
        const { data: globalCat } = await supabase
            .from("categories")
            .select("id")
            .eq("name", categoryName)
            .is("user_id", null)
            .single();

        if (globalCat) return globalCat.id as string;

        // Crear categoría personalizada del usuario
        const { data: created, error } = await supabase
            .from("categories")
            .insert({ name: categoryName, user_id: userId })
            .select("id")
            .single();

        if (error) {
            throw new Error(`Failed to create category "${categoryName}": ${error.message}`);
        }

        return created!.id as string;
    }

    // Sin userId: busca global, crea global
    const { data: existing } = await supabase
        .from("categories")
        .select("id")
        .eq("name", categoryName)
        .is("user_id", null)
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
// Account operations
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
// Transaction operations
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
 * Counts transactions for a user in the current month.
 * Excludes soft-deleted transactions (deleted_at IS NOT NULL).
 */
export async function getMonthlyTransactionCount(userId: string): Promise<number> {
    const supabase = getSupabaseClient();

    // date_trunc('month', now()) en Supabase se logra con un filtro manual
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const { count, error } = await supabase
        .from("transactions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("created_at", firstOfMonth)
        .is("deleted_at", null);

    if (error) {
        console.error("[SUMA] Failed to count monthly transactions:", error);
        throw new Error(`Failed to count transactions: ${error.message}`);
    }

    return count ?? 0;
}
