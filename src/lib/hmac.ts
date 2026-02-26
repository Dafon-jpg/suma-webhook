// ============================================================================
// HMAC Signature Validation — Meta WhatsApp Webhooks
//
// Meta signs every webhook POST with X-Hub-Signature-256 using the App Secret.
// We MUST validate this to prevent payload injection attacks.
// Docs: https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validation-payloads
// ============================================================================

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Validates the HMAC-SHA256 signature of a webhook payload from Meta.
 *
 * @param rawBody - The raw request body as a string (NOT parsed JSON)
 * @param signature - The X-Hub-Signature-256 header value (format: "sha256=<hex>")
 * @param appSecret - The WhatsApp App Secret from Meta dashboard
 * @returns true if signature is valid, false otherwise
 */
export function validateWebhookSignature(
    rawBody: string,
    signature: string | undefined,
    appSecret: string
): boolean {
    if (!signature || !signature.startsWith("sha256=")) {
        return false;
    }

    const expectedHash = createHmac("sha256", appSecret)
        .update(rawBody)
        .digest("hex");

    const receivedHash = signature.slice("sha256=".length);

    // Constant-time comparison to prevent timing attacks
    if (expectedHash.length !== receivedHash.length) {
        return false;
    }

    return timingSafeEqual(
        Buffer.from(expectedHash, "hex"),
        Buffer.from(receivedHash, "hex")
    );
}