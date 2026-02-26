// ============================================================================
// Idempotency Guard — prevents duplicate message processing
//
// Uses the processed_messages table to track WhatsApp message IDs (wamid).
// If Meta retries a webhook and QStash dedup misses it, this is the final gate.
// ============================================================================

import { getSupabaseClient } from "../lib/supabase.js";

/**
 * Attempts to claim a message ID for processing.
 * Uses INSERT with ON CONFLICT DO NOTHING — if the row already exists,
 * the insert silently succeeds with 0 rows affected.
 *
 * @returns true if this is the first time we see this message (safe to process)
 * @returns false if the message was already claimed (skip)
 */
export async function claimMessageId(
    wamid: string,
    userPhone: string
): Promise<boolean> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
        .from("processed_messages")
        .insert({ wamid, user_phone: userPhone })
        .select("wamid")
        .single();

    if (error) {
        // 23505 = unique_violation → message already exists
        if (error.code === "23505") {
            console.log(`[SUMA] ⏭️ Duplicate message skipped: ${wamid}`);
            return false;
        }
        // Unexpected error — let it bubble up so QStash retries
        throw new Error(`Idempotency check failed: ${error.message}`);
    }

    return !!data;
}

/**
 * Marks a message as fully processed (pipeline completed successfully).
 */
export async function markMessageProcessed(wamid: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
        .from("processed_messages")
        .update({ processed: true })
        .eq("wamid", wamid);

    if (error) {
        // Non-critical: log but don't throw
        console.error(`[SUMA] Failed to mark message processed: ${wamid}`, error);
    }
}

/**
 * Records an error against a message (for debugging failed processing).
 */
export async function markMessageError(
    wamid: string,
    errorMessage: string
): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
        .from("processed_messages")
        .update({ error: errorMessage.slice(0, 500) })
        .eq("wamid", wamid);

    if (error) {
        console.error(`[SUMA] Failed to record error for message: ${wamid}`, error);
    }
}
