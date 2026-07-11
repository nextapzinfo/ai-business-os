import { GoogleAuth } from "google-auth-library";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

let cachedAuth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (cachedAuth) return cachedAuth;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is not set");
  }

  // Vercel env vars store literal "\n" — turn them back into real newlines.
  const privateKey = rawKey.replace(/\\n/g, "\n");

  cachedAuth = new GoogleAuth({
    credentials: { client_email: email, private_key: privateKey },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return cachedAuth;
}

async function getAccessToken(): Promise<string> {
  const auth = getAuth();
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error("Failed to obtain Google access token");
  }
  return tokenResponse.token;
}

// Reads a range like "Sheet1!A2:D" and returns rows as string arrays
// (empty cells come back as "" so column positions stay aligned).
export async function readSheetRange(
  spreadsheetId: string,
  range: string
): Promise<string[][]> {
  const token = await getAccessToken();
  const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await res.json();
  if (!res.ok) {
    const errMessage = data?.error?.message || JSON.stringify(data);
    throw new Error(`Google Sheets read failed: ${res.status} ${errMessage}`);
  }

  const values: string[][] = data.values || [];
  const width = Math.max(0, ...values.map((row) => row.length));
  return values.map((row) => {
    const padded = [...row];
    while (padded.length < width) padded.push("");
    return padded;
  });
}

// Appends a single row to the end of the given range's sheet (e.g. "Sheet1!A:D").
export async function appendSheetRow(
  spreadsheetId: string,
  range: string,
  row: (string | number)[]
): Promise<void> {
  const token = await getAccessToken();
  const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(
    range
  )}:append?valueInputOption=USER_ENTERED`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values: [row] }),
  });

  if (!res.ok) {
    const data = await res.json();
    const errMessage = data?.error?.message || JSON.stringify(data);
    throw new Error(`Google Sheets append failed: ${res.status} ${errMessage}`);
  }
}