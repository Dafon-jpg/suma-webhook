// ============================================================================
// WhatsApp Media Download Service
// Downloads audio/image files from WhatsApp Cloud API into memory buffers.
// ============================================================================

import type { MediaContent } from "../types/index.js";

const WA_API_BASE = "https://graph.facebook.com/v21.0";

/**
 * Metadata returned by the WhatsApp Media endpoint.
 */
interface MediaMetaResponse {
    url: string;
    mime_type: string;
    sha256: string;
    file_size: number;
    id: string;
}

/**
 * Downloads a media file from WhatsApp Cloud API given its media ID.
 *
 * Two-step process:
 *   1. GET /v21.0/{media_id} → retrieves the download URL
 *   2. GET {download_url} → downloads the binary file
 *
 * Returns the file as an in-memory Buffer with its MIME type.
 * Throws on any HTTP or network error.
 */
export async function downloadWhatsAppMedia(
    mediaId: string,
    apiToken: string
): Promise<MediaContent> {
    // ── Step 1: Get media metadata (download URL) ──────────────────────────
    const metaUrl = `${WA_API_BASE}/${mediaId}`;

    const metaRes = await fetch(metaUrl, {
        headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!metaRes.ok) {
        const errBody = await metaRes.text();
        console.error(
            `[SUMA] ❌ WhatsApp media metadata error (${metaRes.status}):`,
            errBody
        );
        throw new Error(
            `Failed to get media metadata: HTTP ${metaRes.status}`
        );
    }

    const meta: MediaMetaResponse = await metaRes.json();

    // ── Step 2: Download the binary file ───────────────────────────────────
    const fileRes = await fetch(meta.url, {
        headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!fileRes.ok) {
        const errBody = await fileRes.text();
        console.error(
            `[SUMA] ❌ WhatsApp media download error (${fileRes.status}):`,
            errBody
        );
        throw new Error(
            `Failed to download media file: HTTP ${fileRes.status}`
        );
    }

    const arrayBuffer = await fileRes.arrayBuffer();
    const data = Buffer.from(arrayBuffer);

    console.log(
        `[SUMA] 📥 Media downloaded: ${mediaId} (${meta.mime_type}, ${data.length} bytes)`
    );

    return {
        data,
        mimeType: meta.mime_type,
    };
}
