// LysiPOS — Google Identity Services + Google Drive upload.
// Loads GIS on demand, uses the token client flow (no redirect page needed).

const GIS_URL = 'https://accounts.google.com/gsi/client';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILES  = 'https://www.googleapis.com/drive/v3/files';
const USERINFO     = 'https://www.googleapis.com/oauth2/v3/userinfo';

export const DRIVE_SCOPE   = 'https://www.googleapis.com/auth/drive.file';
export const USERINFO_SCOPE = 'openid email profile';

let gisReady = null;
export function loadGis() {
  if (gisReady) return gisReady;
  gisReady = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const s = document.createElement('script');
    s.src = GIS_URL; s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { gisReady = null; reject(new Error('Failed to load Google Identity Services (are you offline?)')); };
    document.head.appendChild(s);
  });
  return gisReady;
}

/**
 * Request an OAuth access token for the given scopes.
 * Shows Google's popup — no redirect page needed.
 * @param {string} clientId  Your OAuth 2.0 Web Client ID
 * @param {string[]} scopes  e.g. [DRIVE_SCOPE, USERINFO_SCOPE]
 * @param {object} [opts]    { prompt: 'consent'|'' }
 * @returns {Promise<{ access_token: string, expires_in: number, scope: string, token_type: string }>}
 */
export async function requestToken(clientId, scopes, opts = {}) {
  if (!clientId) throw new Error('Google Client ID not set');
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: scopes.join(' '),
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        resolve(resp);
      },
      error_callback: (e) => reject(new Error(e?.message || e?.type || 'Google auth failed'))
    });
    client.requestAccessToken({ prompt: opts.prompt ?? '' });
  });
}

export async function revokeToken(token) {
  if (!token) return;
  await loadGis().catch(() => {});
  return new Promise(resolve => {
    try { window.google.accounts.oauth2.revoke(token, () => resolve()); }
    catch { resolve(); }
  });
}

export async function userInfo(accessToken) {
  const r = await fetch(USERINFO, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!r.ok) throw new Error('userinfo failed: ' + r.status);
  return r.json();
}

/**
 * Find (or create) a folder by name at the root of the user's Drive.
 * Uses drive.file scope, so only folders the app created are visible.
 */
export async function ensureFolder(accessToken, name) {
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and trashed=false`);
  const list = await fetch(`${DRIVE_FILES}?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (!list.ok) throw new Error('folder lookup failed: ' + list.status);
  const j = await list.json();
  if (j.files && j.files.length) return j.files[0].id;
  const create = await fetch(DRIVE_FILES, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!create.ok) throw new Error('folder create failed: ' + create.status);
  return (await create.json()).id;
}

/**
 * Upload a File to Drive via multipart. Returns { id, name, webViewLink }.
 */
export async function driveUpload(accessToken, file, opts = {}) {
  const meta = {
    name: opts.name || file.name || 'upload.bin',
    mimeType: opts.mimeType || file.type || 'application/octet-stream'
  };
  if (opts.parents) meta.parents = opts.parents;

  const boundary = '----lysipos' + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const parts = [
    enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`),
    enc.encode(`--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`),
    new Uint8Array(await file.arrayBuffer()),
    enc.encode(`\r\n--${boundary}--`)
  ];
  const totalLen = parts.reduce((n, c) => n + c.byteLength, 0);
  const body = new Uint8Array(totalLen);
  let off = 0; for (const c of parts) { body.set(c, off); off += c.byteLength; }

  const r = await fetch(DRIVE_UPLOAD + '?uploadType=multipart&fields=id,name,webViewLink,size', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Drive upload failed: ${r.status} ${text.slice(0, 300)}`);
  }
  return r.json();
}
