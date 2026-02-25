// ============================================================================
// Expense Repository — CRUD operations against Supabase
// ============================================================================

import { getSupabaseClient } from "../lib/supabase.js";
import type { ExpenseRow } from "../types/index.js";

/**
 * Inserts a new expense row into the `expenses` table.
 * Returns the inserted row or throws on failure.
 */
export async function insertExpense(expense: ExpenseRow): Promise<ExpenseRow> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("expenses")
    .insert(expense)
    .select()
    .single();

  if (error) {
    console.error("[SUMA] Supabase insert error:", error);
    throw new Error(`Failed to save expense: ${error.message}`);
  }

  return data as ExpenseRow;
}

/**
 * Finds or creates a user by WhatsApp phone number.
 * Returns the user_id (UUID).
 *
 * Uses the `users` table with columns: id (uuid), phone (text), name (text).
 * Performs an upsert on the phone number.
 */
export async function upsertUser(
  phone: string,
  name?: string
): Promise<string> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("users")
    .upsert(
      { phone, name: name ?? null },
      { onConflict: "phone" }
    )
    .select("id")
    .single();

  if (error) {
    console.error("[SUMA] Supabase user upsert error:", error);
    throw new Error(`Failed to upsert user: ${error.message}`);
  }

  return data.id as string;
}

/**
 * Resolves a category name to its UUID from the `categories` table.
 * If the category doesn't exist, creates it.
 */
export async function resolveCategoryId(categoryName: string): Promise<string> {
  const supabase = getSupabaseClient();

  // Try to find existing category
  const { data: existing } = await supabase
    .from("categories")
    .select("id")
    .eq("name", categoryName)
    .single();

  if (existing) return existing.id as string;

  // Create new category
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
