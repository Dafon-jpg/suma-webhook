// ============================================================================
// Confirmation Flow — Lifecycle of pending transactions
//
// Manages the full cycle: create pending → confirm/correct → save.
// Uses pending_confirmations table + WhatsApp interactive messages.
// ============================================================================

import { getSupabaseClient } from "../lib/supabase.js";
import type {
    ParsedTransactionData,
    ParsedSubscription,
    PendingConfirmationRow,
} from "../types/index.js";
import {
    ensureDefaultAccount,
    resolveCategoryId,
    insertTransaction,
} from "./transaction-repository.js";
import {
    sendConfirmationButtons,
    sendFieldSelectionList,
    sendSimpleText,
    buildTransactionSummary,
    buildSubscriptionSummary,
    buildFieldList,
    buildSubscriptionFieldList,
} from "./whatsapp.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SendParams {
    phoneNumberId: string;
    apiToken: string;
}

// ---------------------------------------------------------------------------
// Field correction prompts
// ---------------------------------------------------------------------------

const FIELD_PROMPTS: Record<string, string> = {
    type: "¿Es ingreso, egreso o transferencia?",
    amount: "¿Cuál es el monto correcto?",
    currency: "¿Pesos (ARS) o dólares (USD)?",
    account: "¿De qué cuenta? (Efectivo, Banco, MercadoPago, Tarjeta)",
    description: "¿Cuál es la descripción correcta?",
    category: "¿Qué categoría le ponemos?",
    service_name: "¿Cuál es el nombre del servicio?",
    frequency: "¿Con qué frecuencia? (semanal, mensual, anual)",
};

// ---------------------------------------------------------------------------
// Pending confirmation CRUD
// ---------------------------------------------------------------------------

/**
 * Creates a new pending confirmation, replacing any existing one for the user.
 * Returns the confirmation ID.
 */
export async function createPending(
    userId: string,
    data: ParsedTransactionData | ParsedSubscription,
    confirmationType: "transaction" | "subscription",
): Promise<string> {
    const supabase = getSupabaseClient();

    // Only one pending confirmation per user at a time
    await supabase
        .from("pending_confirmations")
        .delete()
        .eq("user_id", userId);

    const { data: row, error } = await supabase
        .from("pending_confirmations")
        .insert({
            user_id: userId,
            transaction_data: data,
            confirmation_type: confirmationType,
        })
        .select("id")
        .single();

    if (error) {
        console.error("[SUMA] ❌ Failed to create pending confirmation:", error);
        throw new Error(`Failed to create pending confirmation: ${error.message}`);
    }

    const id = row!.id as string;
    console.log(`[SUMA] 📋 Pending confirmation created: ${id.slice(0, 8)} for user ${userId.slice(0, 8)}`);
    return id;
}

/**
 * Gets the active (non-expired) pending confirmation for a user.
 */
export async function getPending(
    userId: string,
): Promise<PendingConfirmationRow | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
        .from("pending_confirmations")
        .select("*")
        .eq("user_id", userId)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

    if (error || !data) return null;

    return data as PendingConfirmationRow;
}

// ---------------------------------------------------------------------------
// Confirmation messaging
// ---------------------------------------------------------------------------

/**
 * Sends the confirmation message with Yes/No buttons to the user.
 */
export async function sendConfirmation(
    pending: PendingConfirmationRow,
    phone: string,
    sendParams: SendParams,
): Promise<void> {
    const summaryText = pending.confirmation_type === "subscription"
        ? buildSubscriptionSummary(pending.transaction_data as ParsedSubscription)
        : buildTransactionSummary(pending.transaction_data as ParsedTransactionData);

    await sendConfirmationButtons({
        to: phone,
        phoneNumberId: sendParams.phoneNumberId,
        apiToken: sendParams.apiToken,
        summaryText,
        confirmationId: pending.id,
    });
}

// ---------------------------------------------------------------------------
// Confirm and save
// ---------------------------------------------------------------------------

/**
 * Confirms a pending transaction: persists to DB and removes the pending record.
 * Returns the transaction ID and a summary string.
 */
export async function confirmAndSave(
    confirmationId: string,
    userId: string,
): Promise<{ transactionId: string; summary: string }> {
    const supabase = getSupabaseClient();

    const { data: row, error } = await supabase
        .from("pending_confirmations")
        .select("*")
        .eq("id", confirmationId)
        .gt("expires_at", new Date().toISOString())
        .single();

    if (error || !row) {
        throw new Error("Confirmación expirada");
    }

    const pending = row as PendingConfirmationRow;

    if (pending.confirmation_type === "transaction") {
        return await saveTransaction(pending, userId, supabase);
    }

    return await saveSubscription(pending, userId, supabase);
}

async function saveTransaction(
    pending: PendingConfirmationRow,
    userId: string,
    supabase: ReturnType<typeof getSupabaseClient>,
): Promise<{ transactionId: string; summary: string }> {
    const data = pending.transaction_data as ParsedTransactionData;

    const [accountId, categoryId] = await Promise.all([
        ensureDefaultAccount(userId),
        resolveCategoryId(data.category, userId),
    ]);

    const saved = await insertTransaction({
        user_id: userId,
        type: data.type,
        amount: data.amount,
        description: data.description,
        category_id: categoryId,
        account_id: accountId,
        is_recurrent: false,
        raw_message: null,
    });

    await supabase
        .from("pending_confirmations")
        .delete()
        .eq("id", pending.id);

    console.log(`[SUMA] 💾 Transaction confirmed: ${saved.id} for user ${userId.slice(0, 8)}`);

    return {
        transactionId: saved.id!,
        summary: buildTransactionSummary(data),
    };
}

async function saveSubscription(
    pending: PendingConfirmationRow,
    userId: string,
    supabase: ReturnType<typeof getSupabaseClient>,
): Promise<{ transactionId: string; summary: string }> {
    const data = pending.transaction_data as ParsedSubscription;

    const [accountId, categoryId] = await Promise.all([
        ensureDefaultAccount(userId),
        resolveCategoryId("suscripcion", userId),
    ]);

    // Save as recurring expense transaction
    const saved = await insertTransaction({
        user_id: userId,
        type: "expense",
        amount: data.amount,
        description: data.service_name,
        category_id: categoryId,
        account_id: accountId,
        is_recurrent: true,
        raw_message: null,
    });

    // Also insert into subscriptions table
    const nextPayment = data.start_date || new Date().toISOString();
    const { error: subError } = await supabase
        .from("subscriptions")
        .insert({
            user_id: userId,
            account_id: accountId,
            service_name: data.service_name,
            amount: data.amount,
            currency: data.currency,
            frequency: data.frequency,
            next_payment_at: nextPayment,
            category_id: categoryId,
        });

    if (subError) {
        console.error("[SUMA] ⚠️ Failed to insert subscription (transaction saved):", subError);
    }

    await supabase
        .from("pending_confirmations")
        .delete()
        .eq("id", pending.id);

    console.log(`[SUMA] 💾 Subscription confirmed: ${saved.id} for user ${userId.slice(0, 8)}`);

    return {
        transactionId: saved.id!,
        summary: buildSubscriptionSummary(data),
    };
}

// ---------------------------------------------------------------------------
// Field correction flow
// ---------------------------------------------------------------------------

/**
 * Starts the field correction: shows a list of editable fields.
 */
export async function startFieldCorrection(
    confirmationId: string,
    phone: string,
    sendParams: SendParams,
): Promise<void> {
    const supabase = getSupabaseClient();

    const { data: row, error } = await supabase
        .from("pending_confirmations")
        .select("*")
        .eq("id", confirmationId)
        .single();

    if (error || !row) {
        throw new Error("Confirmación no encontrada");
    }

    const pending = row as PendingConfirmationRow;
    const fields = pending.confirmation_type === "subscription"
        ? buildSubscriptionFieldList(pending.transaction_data as ParsedSubscription)
        : buildFieldList(pending.transaction_data as ParsedTransactionData);

    await sendFieldSelectionList({
        to: phone,
        phoneNumberId: sendParams.phoneNumberId,
        apiToken: sendParams.apiToken,
        confirmationId,
        fields,
    });

    console.log(`[SUMA] ✏️ Field correction started for ${confirmationId.slice(0, 8)}`);
}

/**
 * Records which field the user wants to edit, then asks for the new value.
 */
export async function selectFieldToEdit(
    confirmationId: string,
    fieldName: string,
    phone: string,
    sendParams: SendParams,
): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
        .from("pending_confirmations")
        .update({ field_editing: fieldName })
        .eq("id", confirmationId);

    if (error) {
        console.error("[SUMA] ❌ Failed to update field_editing:", error);
        throw new Error(`Failed to set field_editing: ${error.message}`);
    }

    const prompt = FIELD_PROMPTS[fieldName] ?? `¿Cuál es el valor correcto para "${fieldName}"?`;

    await sendSimpleText({
        to: phone,
        phoneNumberId: sendParams.phoneNumberId,
        apiToken: sendParams.apiToken,
        text: prompt,
    });
}

/**
 * Applies a corrected value to the pending confirmation and re-sends it.
 */
export async function applyFieldCorrection(
    confirmationId: string,
    newValue: string,
    phone: string,
    sendParams: SendParams,
): Promise<void> {
    const supabase = getSupabaseClient();

    const { data: row, error: fetchError } = await supabase
        .from("pending_confirmations")
        .select("*")
        .eq("id", confirmationId)
        .single();

    if (fetchError || !row) {
        throw new Error("Confirmación no encontrada");
    }

    const pending = row as PendingConfirmationRow;
    const fieldName = pending.field_editing;

    if (!fieldName) {
        throw new Error("No hay campo en edición");
    }

    // Parse the new value according to the field type
    const parsedValue = parseFieldValue(fieldName, newValue);

    // Update the transaction_data with the corrected value
    const updatedData = { ...pending.transaction_data, [fieldName]: parsedValue };

    const { error: updateError } = await supabase
        .from("pending_confirmations")
        .update({
            transaction_data: updatedData,
            field_editing: null,
        })
        .eq("id", confirmationId);

    if (updateError) {
        console.error("[SUMA] ❌ Failed to apply field correction:", updateError);
        throw new Error(`Failed to apply correction: ${updateError.message}`);
    }

    console.log(`[SUMA] ✏️ Field ${fieldName} corrected to "${newValue}" for ${confirmationId.slice(0, 8)}`);

    // Re-send the confirmation with updated data
    const updatedPending: PendingConfirmationRow = {
        ...pending,
        transaction_data: updatedData as ParsedTransactionData | ParsedSubscription,
        field_editing: null,
    };

    await sendConfirmation(updatedPending, phone, sendParams);
}

/**
 * Parses a user-provided value into the correct type for a given field.
 */
function parseFieldValue(fieldName: string, rawValue: string): string | number {
    const value = rawValue.trim();

    switch (fieldName) {
        case "amount": {
            // Argentine format: 15.000,50 → 15000.50
            const normalized = value
                .replace(/[^0-9.,]/g, "")   // strip non-numeric except . and ,
                .replace(/\./g, "")          // remove thousand separators
                .replace(",", ".");           // convert decimal comma to dot
            const num = parseFloat(normalized);
            return isNaN(num) ? 0 : num;
        }

        case "type": {
            const lower = value.toLowerCase();
            if (lower.includes("ingreso") || lower.includes("cobr")) return "income";
            if (lower.includes("transfer")) return "transfer";
            return "expense";
        }

        case "frequency": {
            const lower = value.toLowerCase();
            if (lower.includes("semanal") || lower.includes("week")) return "weekly";
            if (lower.includes("anual") || lower.includes("annual")) return "annual";
            return "monthly";
        }

        default:
            return value;
    }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Removes all expired pending confirmations.
 * Returns the number of rows deleted.
 */
export async function cleanExpired(): Promise<number> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
        .from("pending_confirmations")
        .delete()
        .lt("expires_at", new Date().toISOString())
        .select("id");

    if (error) {
        console.error("[SUMA] ❌ Failed to clean expired confirmations:", error);
        return 0;
    }

    const count = data?.length ?? 0;
    if (count > 0) {
        console.log(`[SUMA] 🧹 Cleaned ${count} expired confirmations`);
    }
    return count;
}
