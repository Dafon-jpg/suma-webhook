// ============================================================================
// Alerts Service — Schedule and process subscription renewal reminders
//
// - scheduleAlert: saves alert_date on a subscription row
// - getFirstBusinessDay: calculates the first weekday of a given month
// - processPendingAlerts: called by cron, sends reminders via WhatsApp
// - renewSubscription: extends end_date by original duration
// - cancelSubscription: marks is_active=false, sets cancelled_at
// ============================================================================

import { getSupabaseClient } from "../lib/supabase.js";
import { sendRenewalReminder } from "./whatsapp.js";
import type { SubscriptionRow } from "../types/index.js";

// ---------------------------------------------------------------------------
// Schedule an alert for a subscription
// ---------------------------------------------------------------------------

/**
 * Saves alert_date on the subscription and resets alert_sent to false.
 */
export async function scheduleAlert(
    subscriptionId: string,
    alertDate: Date,
): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
        .from("subscriptions")
        .update({
            alert_date: alertDate.toISOString(),
            alert_sent: false,
        })
        .eq("id", subscriptionId);

    if (error) {
        console.error(`[SUMA] ❌ Failed to schedule alert for sub ${subscriptionId}:`, error);
        throw new Error(`Failed to schedule alert: ${error.message}`);
    }

    console.log(`[SUMA] 🔔 Alert scheduled for sub ${subscriptionId.slice(0, 8)} on ${alertDate.toISOString().split("T")[0]}`);
}

// ---------------------------------------------------------------------------
// Calculate first business day of a month
// ---------------------------------------------------------------------------

/**
 * Returns the first weekday (Mon-Fri) of the given month/year.
 * If the 1st falls on Saturday → returns Monday the 3rd.
 * If the 1st falls on Sunday → returns Monday the 2nd.
 */
export function getFirstBusinessDay(year: number, month: number): Date {
    const date = new Date(Date.UTC(year, month, 1));
    const day = date.getUTCDay(); // 0=Sun, 6=Sat

    if (day === 6) {
        date.setUTCDate(3); // Sat → Mon
    } else if (day === 0) {
        date.setUTCDate(2); // Sun → Mon
    }

    return date;
}

/**
 * Calculates the default alert date: first business day of the last month
 * before the subscription ends.
 */
export function getDefaultAlertDate(endDate: string): Date {
    const end = new Date(endDate);
    // One month before end_date → first business day of that month
    const alertMonth = end.getUTCMonth() - 1;
    const alertYear = end.getUTCFullYear();
    return getFirstBusinessDay(alertYear, alertMonth);
}

// ---------------------------------------------------------------------------
// Process pending alerts (called by cron job)
// ---------------------------------------------------------------------------

/**
 * Finds all subscriptions with alert_date <= now, alert_sent = false,
 * is_active = true, and whose user has subscription_status = 'active'.
 * Sends renewal reminders via WhatsApp and marks alert_sent = true.
 *
 * Returns the number of alerts sent.
 */
export async function processPendingAlerts(
    phoneNumberId: string,
    apiToken: string,
): Promise<number> {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    // Fetch subscriptions with pending alerts
    const { data: subs, error } = await supabase
        .from("subscriptions")
        .select("id, user_id, service_name, end_date, amount, currency, frequency")
        .eq("is_active", true)
        .eq("alert_sent", false)
        .not("alert_date", "is", null)
        .lte("alert_date", now);

    if (error) {
        console.error("[SUMA] ❌ Failed to fetch pending alerts:", error);
        throw new Error(`Failed to fetch pending alerts: ${error.message}`);
    }

    if (!subs || subs.length === 0) {
        console.log("[SUMA] 🔔 No pending alerts to process");
        return 0;
    }

    let sent = 0;

    for (const sub of subs) {
        try {
            // Verify user has active subscription status
            const { data: user } = await supabase
                .from("users")
                .select("phone, subscription_status")
                .eq("id", sub.user_id)
                .single();

            if (!user || user.subscription_status !== "active") {
                console.log(`[SUMA] ⏭️ Skipping alert for sub ${sub.id}: user not active`);
                continue;
            }

            // Send the reminder
            await sendRenewalReminder({
                to: user.phone,
                phoneNumberId,
                apiToken,
                subscriptionId: sub.id,
                serviceName: sub.service_name,
                endDate: sub.end_date!,
            });

            // Mark as sent (idempotency guard)
            await supabase
                .from("subscriptions")
                .update({ alert_sent: true })
                .eq("id", sub.id)
                .eq("alert_sent", false); // Double-check to prevent races

            sent++;
            console.log(`[SUMA] 🔔 Alert sent for sub ${sub.id.slice(0, 8)} (${sub.service_name})`);
        } catch (err) {
            console.error(`[SUMA] ❌ Failed to process alert for sub ${sub.id}:`, err);
            // Continue with next subscription — don't block batch on one failure
        }
    }

    console.log(`[SUMA] 🔔 Processed ${sent}/${subs.length} alerts`);
    return sent;
}

// ---------------------------------------------------------------------------
// Renew a subscription (extend end_date)
// ---------------------------------------------------------------------------

/**
 * Extends the subscription by recalculating end_date from the current end_date
 * using the original frequency-based duration. Resets alert fields.
 */
export async function renewSubscription(subscriptionId: string): Promise<SubscriptionRow | null> {
    const supabase = getSupabaseClient();

    const { data: sub, error: fetchError } = await supabase
        .from("subscriptions")
        .select("*")
        .eq("id", subscriptionId)
        .single();

    if (fetchError || !sub) {
        console.error(`[SUMA] ❌ Subscription not found for renewal: ${subscriptionId}`);
        return null;
    }

    const subscription = sub as SubscriptionRow;

    if (!subscription.end_date) {
        console.log(`[SUMA] ⚠️ Cannot renew indefinite subscription ${subscriptionId}`);
        return null;
    }

    // Calculate new end_date: old end_date + same duration
    const oldEnd = new Date(subscription.end_date);
    const start = new Date(subscription.next_payment_at);
    const durationMs = oldEnd.getTime() - start.getTime();
    const newEnd = new Date(oldEnd.getTime() + durationMs);

    const { data: updated, error: updateError } = await supabase
        .from("subscriptions")
        .update({
            end_date: newEnd.toISOString(),
            next_payment_at: oldEnd.toISOString(), // Old end becomes new start
            alert_date: null,
            alert_sent: false,
            cancelled_at: null,
            is_active: true,
        })
        .eq("id", subscriptionId)
        .select("*")
        .single();

    if (updateError) {
        console.error(`[SUMA] ❌ Failed to renew subscription:`, updateError);
        return null;
    }

    console.log(`[SUMA] 🔄 Subscription ${subscriptionId.slice(0, 8)} renewed until ${newEnd.toISOString().split("T")[0]}`);
    return updated as SubscriptionRow;
}

// ---------------------------------------------------------------------------
// Cancel a subscription
// ---------------------------------------------------------------------------

/**
 * Marks subscription as cancelled: is_active=false, cancelled_at=now.
 */
export async function cancelSubscription(subscriptionId: string): Promise<boolean> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
        .from("subscriptions")
        .update({
            is_active: false,
            cancelled_at: new Date().toISOString(),
            alert_date: null,
        })
        .eq("id", subscriptionId);

    if (error) {
        console.error(`[SUMA] ❌ Failed to cancel subscription:`, error);
        return false;
    }

    console.log(`[SUMA] ❌ Subscription ${subscriptionId.slice(0, 8)} cancelled`);
    return true;
}
