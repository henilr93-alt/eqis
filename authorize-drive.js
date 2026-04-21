#!/usr/bin/env node
/**
 * One-time OAuth authorization for Google Drive uploads.
 *
 * What this does:
 *   1. Loads state/gdrive-oauth-client.json (the OAuth client credentials)
 *   2. Starts a tiny local HTTP server on 127.0.0.1:53682 as the redirect target
 *   3. Opens your browser to Google's consent page
 *   4. After you click "Allow", Google redirects back with an authorization code
 *   5. Script exchanges the code for an access token + refresh token
 *   6. Saves refresh token to state/gdrive-oauth-token.json
 *
 * Run:  node authorize-drive.js
 *
 * The refresh token is persistent (does not expire as long as you don't
 * revoke it). Every future upload reuses it automatically.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const { execSync } = require('child_process');
const { google } = require('googleapis');

const CLIENT_PATH = path.join(__dirname, 'state', 'gdrive-oauth-client.json');
const TOKEN_PATH = path.join(__dirname, 'state', 'gdrive-oauth-token.json');
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth/callback`;
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function loadClient() {
  if (!fs.existsSync(CLIENT_PATH)) {
    console.error('Missing ' + CLIENT_PATH);
    console.error('Paste your OAuth client JSON into that file first.');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(CLIENT_PATH, 'utf-8'));
  const c = raw.installed || raw.web || raw;
  if (!c.client_id || !c.client_secret) {
    console.error('OAuth client JSON missing client_id/client_secret');
    process.exit(1);
  }
  return c;
}

function openInBrowser(u) {
  try {
    if (process.platform === 'darwin') execSync(`open "${u}"`);
    else if (process.platform === 'win32') execSync(`start "" "${u}"`);
    else execSync(`xdg-open "${u}"`);
    return true;
  } catch { return false; }
}

async function main() {
  const client = loadClient();
  const oauth2Client = new google.auth.OAuth2(
    client.client_id,
    client.client_secret,
    REDIRECT_URI
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  // Start the local server BEFORE opening the browser
  const codePromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const q = url.parse(req.url, true).query;
      if (q.code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
<!doctype html>
<html><head><title>EQIS — Drive authorized</title>
<style>body{font-family:sans-serif;background:#0b1020;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1a1f3a;padding:40px 60px;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.3);text-align:center;max-width:500px}
h1{color:#7c3aed;margin:0 0 12px}
p{color:#cbd5e1;line-height:1.5}</style></head>
<body><div class="card">
<h1>✓ Authorized</h1>
<p>EQIS can now upload recordings to your Google Drive.<br>
You can close this tab and return to the terminal.</p>
</div></body></html>`);
        server.close();
        resolve(q.code);
      } else if (q.error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Error: ' + q.error);
        server.close();
        reject(new Error('OAuth denied: ' + q.error));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      console.log('');
      console.log('→ Listening for callback on ' + REDIRECT_URI);
      console.log('');
      const opened = openInBrowser(authUrl);
      if (opened) {
        console.log('✓ Opened browser for consent. Click "Allow" on the Google page.');
      } else {
        console.log('Open this URL in your browser:');
        console.log('  ' + authUrl);
      }
      console.log('');
    });
    setTimeout(() => { server.close(); reject(new Error('Auth timed out after 5 min')); }, 5 * 60 * 1000);
  });

  const code = await codePromise;
  console.log('✓ Got authorization code, exchanging for tokens...');
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    console.error('No refresh_token returned. You may have previously authorized this app.');
    console.error('To force a new refresh token, revoke access at https://myaccount.google.com/permissions');
    console.error('then re-run this script.');
    process.exit(1);
  }

  fs.writeFileSync(TOKEN_PATH, JSON.stringify({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token || null,
    expiry_date: tokens.expiry_date || null,
    scope: tokens.scope || SCOPES.join(' '),
    saved_at: new Date().toISOString(),
  }, null, 2));

  console.log('');
  console.log('✓ Saved refresh token to ' + TOKEN_PATH);
  console.log('');
  console.log('For Railway deployment, set these env vars:');
  console.log('  GDRIVE_OAUTH_CLIENT_ID     = ' + client.client_id);
  console.log('  GDRIVE_OAUTH_CLIENT_SECRET = ' + client.client_secret);
  console.log('  GDRIVE_OAUTH_REFRESH_TOKEN = ' + tokens.refresh_token);
  console.log('  GDRIVE_FOLDER_ID           = (paste your folder id)');
  console.log('  RECORDING_STORAGE          = gdrive');
  console.log('');
}

main().catch(err => {
  console.error('Auth failed:', err.message);
  process.exit(1);
});
