// ============================================================================
// Chat Memory — Conversational history for Gemini context
//
// Manages short-term memory in the chat_sessions table.
// Recent messages are injected into the Gemini prompt for context.
// ============================================================================

import { getSupabaseClient } from "../lib/supabase.js";
import type { ChatMessage } from "../types/index.js";

const MAX_CONTENT_LENGTH = 2000;

/**
 * Gets the most recent messages for a user, in chronological order.
 */
export async function getRecentHistory(
    userId: string,
    limit: number = 8,
): Promise<ChatMessage[]> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
        .from("chat_sessions")
        .select("id, user_id, role, content, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);

    if (error) {
        console.error("[SUMA] ❌ Failed to fetch chat history:", error);
        throw new Error(`Failed to fetch chat history: ${error.message}`);
    }

    if (!data || data.length === 0) return [];

    // Reverse to chronological order (oldest first)
    return (data as ChatMessage[]).reverse();
}

/**
 * Saves a message to the chat history.
 * Content is truncated to MAX_CONTENT_LENGTH to prevent bloat.
 */
export async function saveMessage(
    userId: string,
    role: "user" | "assistant" | "system",
    content: string,
): Promise<void> {
    const supabase = getSupabaseClient();

    const truncated = content.length > MAX_CONTENT_LENGTH
        ? content.slice(0, MAX_CONTENT_LENGTH)
        : content;

    const { error } = await supabase
        .from("chat_sessions")
        .insert({ user_id: userId, role, content: truncated });

    if (error) {
        console.error("[SUMA] ❌ Failed to save chat message:", error);
        throw new Error(`Failed to save chat message: ${error.message}`);
    }

    console.log(`[SUMA] 💬 Chat saved: ${role} for ${userId.slice(0, 8)}...`);
}

/**
 * Deletes all chat history for a user.
 */
export async function clearHistory(userId: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
        .from("chat_sessions")
        .delete()
        .eq("user_id", userId);

    if (error) {
        console.error("[SUMA] ❌ Failed to clear chat history:", error);
        throw new Error(`Failed to clear chat history: ${error.message}`);
    }

    console.log(`[SUMA] 🗑️ Chat history cleared for ${userId.slice(0, 8)}...`);
}

/**
 * Prunes old messages to keep the table from growing indefinitely.
 * Keeps the most recent maxMessages per user, deletes the rest.
 */
export async function pruneOldHistory(
    userId: string,
    maxMessages: number = 50,
): Promise<void> {
    const supabase = getSupabaseClient();

    // Get the created_at of the Nth most recent message
    const { data: boundary } = await supabase
        .from("chat_sessions")
        .select("created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .range(maxMessages, maxMessages)
        .single();

    // If there's no boundary row, the user has <= maxMessages — nothing to prune
    if (!boundary) return;

    const { error } = await supabase
        .from("chat_sessions")
        .delete()
        .eq("user_id", userId)
        .lt("created_at", boundary.created_at);

    if (error) {
        console.error("[SUMA] ❌ Failed to prune chat history:", error);
        return;
    }

    console.log(`[SUMA] 🧹 Pruned old chat messages for ${userId.slice(0, 8)}...`);
}
