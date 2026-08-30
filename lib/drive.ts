/**
 * Google Drive upload, via a service account.
 *
 * A study pack, once its teacher approves it, is dropped into the school's own
 * Drive folder for that subject and year. Auth is a single server-side service
 * account (README "Drive + docx render"): the school shares each target folder
 * with the service account's email, and the upload happens server-side on
 * approval — no per-teacher Google login, so this does not wait on SSO.
 *
 * No SDK: the JWT is signed with Node crypto and the REST API is called with
 * fetch, so there is no new dependency to bundle. When MOCK_DRIVE=1 (or no
 * credential is set) every upload is faked — a stable link, no network — so the
 * whole approval→Drive path is exercisable before the credential exists, the same
 * way MOCK_LLM exercises the model path.
 */
import crypto from 'node:crypto';

export interface DriveUpload {
  folderId: string; filename: string; bytes: Uint8Array; contentType: string;
}
export interface DriveResult {
  ok: boolean; mock: boolean;
  fileId?: string; link?: string; folderId?: string; error?: string;
}

/** Mocked when explicitly asked, or whenever no service-account credential is set. */
export function driveMocked(): boolean {
  return process.env.MOCK_DRIVE === '1' || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
}

export async function uploadToDrive(u: DriveUpload): Promise<DriveResult> {
  if (driveMocked()) {
    // A deterministic-enough fake: a real-looking Drive id and view link, no call.
    const fileId = 'mock_' + crypto.randomBytes(12).toString('hex');
    return { ok: true, mock: true, fileId, folderId: u.folderId,
      link: `https://drive.google.com/file/d/${fileId}/view` };
  }
  try {
    const token = await accessToken();
    const meta = { name: u.filename, parents: [u.folderId] };
    const boundary = 'lots' + crypto.randomBytes(8).toString('hex');
    const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
      + `${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${u.contentType}\r\n\r\n`;
    const post = `\r\n--${boundary}--`;
    const body = Buffer.concat([Buffer.from(pre), Buffer.from(u.bytes), Buffer.from(post)]);

    const res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` }, body },
    );
    if (!res.ok) return { ok: false, mock: false, error: `drive ${res.status}: ${await res.text()}` };
    const file = await res.json() as { id: string; webViewLink?: string };
    return { ok: true, mock: false, fileId: file.id, folderId: u.folderId,
      link: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view` };
  } catch (e) {
    return { ok: false, mock: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Mint an OAuth access token from the service-account key (RS256 JWT bearer grant). */
async function accessToken(): Promise<string> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON!.trim();
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(json) as { client_email: string; private_key: string };

  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })}`;
  const signature = crypto.createSign('RSA-SHA256').update(input)
    .sign(sa.private_key.replace(/\\n/g, '\n')).toString('base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${signature}` }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return (await res.json() as { access_token: string }).access_token;
}
