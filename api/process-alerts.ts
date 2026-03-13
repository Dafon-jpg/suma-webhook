// ============================================================================
// SUMA — Subscription Alert Cron Worker (api/process-alerts.ts)
//
// Called by QStash cron schedule. Finds subscriptions with pending alerts
// and sends renewal reminders via WhatsApp.
//
// Security: verifies CRON_SECRET to prevent unauthorized calls.
// Idempotent: uses alert_sent flag — safe for QStash retries.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadConfig } from "../src/utils/config.js";
import { processPendingAlerts } from "../src/services/alerts.js";

export default async function handler(
    req: VercelRequest,
    res: VercelResponse,
): Promise<void> {
    console.log("[SUMA] 🔔 process-alerts hit");

    if (req.method !== "POST" && req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }

    try {
        // Verify cron secret (QStash or Vercel cron)
        const cronSecret = process.env.CRON_SECRET;
        if (cronSecret) {
            const authHeader = req.headers.authorization;
            const querySecret = req.query?.secret;

            const providedSecret = authHeader?.replace("Bearer ", "") ?? querySecret;

            if (providedSecret !== cronSecret) {
                console.error("[SUMA] ❌ Invalid cron secret");
                res.status(401).json({ error: "Unauthorized" });
                return;
            }
        }

        const config = loadConfig();

        const alertsSent = await processPendingAlerts(
            config.WHATSAPP_PHONE_NUMBER_ID,
            config.WHATSAPP_API_TOKEN,
        );

        res.status(200).json({
            status: "ok",
            alertsSent,
            processedAt: new Date().toISOString(),
        });
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error("[SUMA] ❌ process-alerts error:", errorMsg);
        res.status(500).json({ error: "Alert processing failed" });
    }
}
