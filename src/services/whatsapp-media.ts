// ============================================================================
// WhatsApp Media Download Service — with retry & exponential backoff
//
// Downloads audio/image files from WhatsApp Cloud API.
// The Meta media API is unreliable under load, so we retry transient failures.
// ============================================================================

import type { MediaContent } from "../types/index.js";

const WA_API_BASE = "https://graph.facebook.com/v21.0";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 800;

interface MediaMetaResponse {
    url: string;
    mime_type: string;
    sha256: string;
    file_size: number;
    id: string;
}

/**
 * Determines if an HTTP error is transient (worth retrying).
 */
function isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
}

/**
 * Sleeps for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches a URL with automatic retry on transient errors.
 * Uses exponential backoff: 800ms → 1600ms → 3200ms.
 */
async function fetchWithRetry(
    url: string,
    options: RequestInit,
    context: string
): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(url, options);

            if (res.ok) return res;

            // Non-retryable HTTP error → fail immediately
            if (!isRetryableStatus(res.status)) {
                const body = await res.text();
                throw new Error(
                    `${context} failed: HTTP ${res.status} — ${body}`
                );
            }

            // Retryable error → log and retry
            const body = await res.text();
            lastError = new Error(
                `${context}: HTTP ${res.status} — ${body}`
            );
            console.warn(
                `[SUMA] ⚠️ ${context} attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (${res.status})`
            );
        } catch (err) {
            // Network error (timeout, DNS, etc.) → retry
            lastError = err instanceof Error ? err : new Error(String(err));
            console.warn(
                `[SUMA] ⚠️ ${context} attempt ${attempt + 1}/${MAX_RETRIES + 1} network error: ${lastError.message}`
            );
        }

        if (attempt < MAX_RETRIES) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt);
            await sleep(delay);
        }
    }

    throw lastError ?? new Error(`${context} failed after ${MAX_RETRIES + 1} attempts`);
}

/**
 * Downloads a media file from WhatsApp Cloud API given its media ID.
 *
 * Two-step process with retry on each step:
 *   1. GET /v21.0/{media_id} → retrieves the download URL
 *   2. GET {download_url}   → downloads the binary file
 */
export async function downloadWhatsAppMedia(
    mediaId: string,
    apiToken: string
): Promise<MediaContent> {
    const headers = { Authorization: `Bearer ${apiToken}` };

    // Step 1: Get media metadata (download URL)
    const metaRes = await fetchWithRetry(
        `${WA_API_BASE}/${mediaId}`,
        { headers },
        `Media metadata ${mediaId}`
    );

    const meta: MediaMetaResponse = await metaRes.json();

    // Step 2: Download the binary file
    const fileRes = await fetchWithRetry(
        meta.url,
        { headers },
        `Media download ${mediaId}`
    );

    const arrayBuffer = await fileRes.arrayBuffer();
    const data = Buffer.from(arrayBuffer);

    console.log(
        `[SUMA] 📥 Media downloaded: ${mediaId} (${meta.mime_type}, ${data.length} bytes)`
    );

    return { data, mimeType: meta.mime_type };
}
