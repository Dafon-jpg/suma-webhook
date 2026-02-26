// ============================================================================
// Google Sheets Service — Create, share, and append to user spreadsheets
//
// 📦 Required npm packages:
//   npm install googleapis
//
// 🔧 Google Cloud Console setup:
//   1. Create a project at https://console.cloud.google.com
//   2. Enable these APIs:
//      - Google Sheets API
//      - Google Drive API
//   3. Create a Service Account (IAM & Admin → Service Accounts)
//   4. Download the JSON key file
//   5. Set these env vars in Vercel:
//      - GOOGLE_SERVICE_ACCOUNT_EMAIL  (client_email from the JSON)
//      - GOOGLE_PRIVATE_KEY            (private_key from the JSON)
//
// ⚠️ GOOGLE_PRIVATE_KEY comes with literal "\n" in the JSON.
//    We replace them with real newlines at runtime (see getAuth below).
// ============================================================================

import { google, type sheets_v4, type drive_v3 } from "googleapis";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SheetCreationResult {
    spreadsheetId: string;
    spreadsheetUrl: string;
}

export interface ExpenseSheetRow {
    date: string;        // ISO date or formatted string
    description: string;
    category: string;
    amount: number;
}

// ---------------------------------------------------------------------------
// Auth — Service Account with Sheets + Drive scopes
// ---------------------------------------------------------------------------

function getAuth() {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const rawKey = process.env.GOOGLE_PRIVATE_KEY;

    if (!email || !rawKey) {
        throw new Error(
            "[SUMA] Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY env vars"
        );
    }

    // Replace literal \n with real newlines (common when pasting from JSON)
    const privateKey = rawKey.replace(/\\n/g, "\n");

    return new google.auth.JWT({
        email,
        key: privateKey,
        scopes: [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive",
        ],
    });
}

function getSheetsClient(): sheets_v4.Sheets {
    return google.sheets({ version: "v4", auth: getAuth() });
}

function getDriveClient(): drive_v3.Drive {
    return google.drive({ version: "v3", auth: getAuth() });
}

// ---------------------------------------------------------------------------
// Create & Share
// ---------------------------------------------------------------------------

/**
 * Creates a new Google Sheet for a user and shares it as read-only.
 *
 * Steps:
 *   1. Create a spreadsheet with headers via Sheets API
 *   2. Share it with the user's email via Drive API
 *   3. Get the web view link from Drive API
 *
 * @returns { spreadsheetId, spreadsheetUrl }
 */
export async function createAndShareUserSheet(
    userEmail: string,
    userPhone: string
): Promise<SheetCreationResult> {
    const sheets = getSheetsClient();
    const drive = getDriveClient();

    // ── Step 1: Create the spreadsheet ─────────────────────────────────────
    const createRes = await sheets.spreadsheets.create({
        requestBody: {
            properties: {
                title: `Suma Digital - ${userPhone}`,
            },
            sheets: [
                {
                    properties: {
                        title: "Gastos",
                        gridProperties: { frozenRowCount: 1 },
                    },
                    data: [
                        {
                            startRow: 0,
                            startColumn: 0,
                            rowData: [
                                {
                                    values: [
                                        { userEnteredValue: { stringValue: "Fecha" } },
                                        { userEnteredValue: { stringValue: "Descripción" } },
                                        { userEnteredValue: { stringValue: "Categoría" } },
                                        { userEnteredValue: { stringValue: "Monto" } },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    });

    const spreadsheetId = createRes.data.spreadsheetId;

    if (!spreadsheetId) {
        throw new Error("[SUMA] Sheets API did not return a spreadsheetId");
    }

    // ── Step 2: Share with user (read-only) ────────────────────────────────
    await drive.permissions.create({
        fileId: spreadsheetId,
        requestBody: {
            role: "reader",
            type: "user",
            emailAddress: userEmail,
        },
        sendNotificationEmail: true,
    });

    // ── Step 3: Get the web view link ──────────────────────────────────────
    const fileRes = await drive.files.get({
        fileId: spreadsheetId,
        fields: "webViewLink",
    });

    const spreadsheetUrl =
        fileRes.data.webViewLink ??
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

    console.log(
        `[SUMA] 📊 Sheet created for ${userPhone}: ${spreadsheetUrl}`
    );

    return { spreadsheetId, spreadsheetUrl };
}

// ---------------------------------------------------------------------------
// Append Expense Row
// ---------------------------------------------------------------------------

/**
 * Appends an expense row to the user's spreadsheet.
 *
 * @param spreadsheetId - The Google Sheets ID
 * @param expense       - The expense data to append
 */
export async function appendExpenseToSheet(
    spreadsheetId: string,
    expense: ExpenseSheetRow
): Promise<void> {
    const sheets = getSheetsClient();

    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Gastos!A:D",
        valueInputOption: "USER_ENTERED",
        requestBody: {
            values: [
                [expense.date, expense.description, expense.category, expense.amount],
            ],
        },
    });

    console.log(
        `[SUMA] 📝 Row appended to sheet ${spreadsheetId}: ${expense.description} $${expense.amount}`
    );
}
