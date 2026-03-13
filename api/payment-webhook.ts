// ============================================================================
// SUMA — MercadoPago Payment Webhook (api/payment-webhook.ts)
//
// Receives IPN (Instant Payment Notification) from MercadoPago.
// When a payment is approved, activates the user's subscription.
//
// MercadoPago sends a POST with:
//   { action: "payment.created", data: { id: "123456" } }
//
// We then query the payment details to get the payer email,
// look up the user, and activate their subscription.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseClient } from "../src/lib/supabase.js";
import { loadConfig } from "../src/utils/config.js";
import { activateSubscription } from "../src/services/sales-flow.js";

console.log("[SUMA:PAYMENT] ✅ payment-webhook module loaded");

export default async function handler(
    req: VercelRequest,
    res: VercelResponse,
): Promise<void> {
    console.log(`[SUMA:PAYMENT] 📥 ${req.method} from ${req.headers["user-agent"]?.slice(0, 50) ?? "unknown"}`);

    // MercadoPago sends GET for validation and POST for notifications
    if (req.method === "GET") {
        res.status(200).json({ status: "ok" });
        return;
    }

    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    try {
        const config = loadConfig();
        const mpToken = process.env.MP_ACCESS_TOKEN;

        if (!mpToken) {
            console.error("[SUMA:PAYMENT] ❌ MP_ACCESS_TOKEN not configured");
            res.status(500).json({ error: "Payment processor not configured" });
            return;
        }

        const body = req.body;
        console.log(`[SUMA:PAYMENT] 📨 Notification:`, JSON.stringify(body).slice(0, 200));

        // MercadoPago IPN v2 format
        const action = body?.action ?? body?.type;
        const paymentId = body?.data?.id;

        if (!paymentId) {
            console.log("[SUMA:PAYMENT] ⏭️ No payment ID in notification, skipping");
            res.status(200).json({ status: "ignored" });
            return;
        }

        // Only process approved payments
        if (action !== "payment.created" && action !== "payment.updated" && action !== "payment") {
            console.log(`[SUMA:PAYMENT] ⏭️ Ignoring action: ${action}`);
            res.status(200).json({ status: "ignored" });
            return;
        }

        // Fetch payment details from MercadoPago
        const paymentRes = await fetch(
            `https://api.mercadopago.com/v1/payments/${paymentId}`,
            {
                headers: { Authorization: `Bearer ${mpToken}` },
            },
        );

        if (!paymentRes.ok) {
            console.error(`[SUMA:PAYMENT] ❌ Failed to fetch payment ${paymentId}: ${paymentRes.status}`);
            res.status(500).json({ error: "Failed to verify payment" });
            return;
        }

        const payment = await paymentRes.json();
        console.log(`[SUMA:PAYMENT] 💰 Payment ${paymentId}: status=${payment.status}, email=${payment.payer?.email}`);

        if (payment.status !== "approved") {
            console.log(`[SUMA:PAYMENT] ⏭️ Payment not approved (${payment.status}), skipping`);
            res.status(200).json({ status: "not_approved" });
            return;
        }

        // Find the user by email (external_reference) or payer email
        const email = payment.external_reference ?? payment.payer?.email;
        if (!email) {
            console.error("[SUMA:PAYMENT] ❌ No email found in payment data");
            res.status(200).json({ status: "no_email" });
            return;
        }

        const supabase = getSupabaseClient();
        const { data: user } = await supabase
            .from("users")
            .select("id, phone")
            .eq("email", email)
            .single();

        if (!user) {
            console.error(`[SUMA:PAYMENT] ❌ No user found with email: ${email}`);
            res.status(200).json({ status: "user_not_found" });
            return;
        }

        console.log(`[SUMA:PAYMENT] ✅ Found user ${user.id} (phone: ${user.phone}) for email ${email}`);

        // Activate subscription and send welcome message
        const sendParams = {
            phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
            apiToken: config.WHATSAPP_API_TOKEN,
        };

        await activateSubscription(user.phone, sendParams);

        res.status(200).json({ status: "activated", userId: user.id });
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error("[SUMA:PAYMENT] ❌ Error:", errorMsg);
        res.status(500).json({ error: "Webhook processing failed" });
    }
}
