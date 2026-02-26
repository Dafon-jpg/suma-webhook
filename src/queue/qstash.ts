// ============================================================================
// Upstash QStash — Publish & Verify
//
// Handles enqueuing messages to QStash and verifying incoming requests
// from QStash (signature validation on the worker side).
// ============================================================================

import { Receiver } from "@upstash/qstash";
import type { QueuedMessagePayload } from "../types/index.js";

const QSTASH_PUBLISH_URL = "https://qstash.upstash.io/v2/publish/";

// ---------------------------------------------------------------------------
// Publish a message to the worker endpoint via QStash
// ---------------------------------------------------------------------------

interface PublishOptions {
    qstashToken: string;
    targetUrl: string;
    payload: QueuedMessagePayload;
    /** Number of automatic retries QStash will perform on failure (default: 3) */
    retries?: number;
}

/**
 * Publishes a message to QStash, which will deliver it to the target URL.
 * QStash handles retries with exponential backoff automatically.
 */
export async function publishToQStash({
    qstashToken,
    targetUrl,
    payload,
    retries = 3,
}: PublishOptions): Promise<{ messageId: string }> {
    const res = await fetch(`${QSTASH_PUBLISH_URL}${targetUrl}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${qstashToken}`,
            "Content-Type": "application/json",
            "Upstash-Retries": String(retries),
            // Dedup based on WhatsApp message ID (QStash dedup window = 24h)
            "Upstash-Deduplication-Id": payload.message.id,
        },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(
            `QStash publish failed (${res.status}): ${errBody}`
        );
    }

    const data = (await res.json()) as { messageId: string };
    return data;
}

// ---------------------------------------------------------------------------
// Verify incoming QStash request signatures (worker side)
// ---------------------------------------------------------------------------

let receiverInstance: Receiver | null = null;

function getReceiver(
    currentSigningKey: string,
    nextSigningKey: string
): Receiver {
    if (!receiverInstance) {
        receiverInstance = new Receiver({
            currentSigningKey,
            nextSigningKey,
        });
    }
    return receiverInstance;
}

/**
 * Verifies that an incoming request was actually sent by QStash.
 * Uses the Upstash Receiver SDK which handles key rotation automatically.
 *
 * @param signature - The Upstash-Signature header
 * @param body - The raw request body as string
 * @param currentSigningKey - QSTASH_CURRENT_SIGNING_KEY env var
 * @param nextSigningKey - QSTASH_NEXT_SIGNING_KEY env var
 * @returns true if the signature is valid
 */
export async function verifyQStashSignature(
    signature: string,
    body: string,
    currentSigningKey: string,
    nextSigningKey: string
): Promise<boolean> {
    try {
        const receiver = getReceiver(currentSigningKey, nextSigningKey);
        await receiver.verify({ signature, body });
        return true;
    } catch {
        return false;
    }
}
