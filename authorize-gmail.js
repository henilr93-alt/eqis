#!/usr/bin/env node
/**
 * One-time OAuth authorization for the EQIS daily-digest emailer.
 *
 * What this does (mirrors authorize-drive.js — same pattern, gmail.send scope):
 *   1. Loads state/gmail-oauth-client.json (the OAuth client credentials)
 *   2. Starts a tiny local HTTP server on 127.0.0.1:53682 as the redirect target
 *   3. Opens your browser to Google's consent page
 *   4. After you click "Allow", Google redirects back with an authorization code
 *   5. Script exchanges the code for an access token + refresh token
 *   6. Saves refresh token to state/gmail-oauth-token.json
 *
 * Run:  node authorize-gmail.js
 *
 * IMPORTANT: log in as eqis@etrav.in (not your personal Google account) on
 * the consent page that opens. The refresh token issued belongs to whoever
 * signs in, and that's the identity emails will be sent from.
 *
 * The refresh token is persistent (does not expire as long as you don't
 * revoke it). Every future send reuses it automatically.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');
const { execSync } = require('child_process');
const { google } = require('googleapis');

const CLIENT_PATH = path.join(__dirname, 'state', 'gmail-oauth-client.json');
const TOKEN_PATH = path.join(__dirname, 'state', 'gmail-oauth-token.json');
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth/callback`;
// gmail.send  → daily-digest sending (existing).
// gmail.readonly → FRAKA reads the eqis@etrav.in inbox to spot tech-team replies
//                  asking for a run's details (Engine 9 email-reply, Leg 1).
// One re-auth grants BOTH; the existing send pipeline keeps working unchanged.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

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
<html><head><title>EQIS — Gmail authorized</title>
<style>body{font-family:sans-serif;background:#0b1020;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#1a1f3a;padding:40px 60px;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.3);text-align:center;max-width:500px}
h1{color:#0a7f3f;margin:0 0 12px}
p{color:#cbd5e1;line-height:1.5}
.detail{font-size:12px;color:#94a3b8;margin-top:16px;padding-top:12px;border-top:1px solid #334155}</style></head>
<body><div class="card">
<h1>✓ Gmail authorized</h1>
<p>EQIS can now send the daily digests from this Gmail account.<br>
You can close this tab and return to the terminal.</p>
<div class="detail">Scopes granted: gmail.send + gmail.readonly (send digests + read inbox replies)</div>
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
      console.log('  ⚠  SIGN IN AS eqis@etrav.in on the Google page that opens.');
      console.log('     Whoever logs in becomes the sender identity for every digest.');
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
    setTimeout(() => { server.close(); reject(new Error('Auth timed out after 10 min')); }, 10 * 60 * 1000);
  });

  const code = await codePromise;
  console.log('✓ Got authorization code, exchanging for tokens...');
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    console.error('');
    console.error('✗ No refresh_token returned. You may have previously authorized this app.');
    console.error('  To force a new refresh token: revoke access at https://myaccount.google.com/permissions');
    console.error('  (sign in as eqis@etrav.in first), then re-run this script.');
    process.exit(1);
  }

  // Verify the sender identity — fetch the profile email so we record who it belongs to
  let senderEmail = null;
  try {
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    senderEmail = profile.data.emailAddress || null;
  } catch (e) {
    console.warn('(could not fetch sender profile: ' + e.message + ')');
  }

  fs.writeFileSync(TOKEN_PATH, JSON.stringify({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token || null,
    expiry_date: tokens.expiry_date || null,
    scope: tokens.scope || SCOPES.join(' '),
    sender_email: senderEmail,
    saved_at: new Date().toISOString(),
  }, null, 2));

  console.log('');
  console.log('✓ Saved refresh token to ' + TOKEN_PATH);
  if (senderEmail) {
    console.log('✓ Sender identity confirmed: ' + senderEmail);
    if (senderEmail.toLowerCase() !== 'eqis@etrav.in') {
      console.warn('');
      console.warn('  ⚠  WARNING: You authorized as ' + senderEmail + ', not eqis@etrav.in.');
      console.warn('     Every digest will go out from this address. Revoke at');
      console.warn('     https://myaccount.google.com/permissions and re-run if wrong.');
    }
  }
  console.log('');
  console.log('Restart EQIS to activate LIVE mailer mode:');
  console.log('  - The dashboard Notifications tab will switch from DRY-RUN to LIVE');
  console.log('  - Daily digests will fire at 9:00 AM IST every day');
  console.log('  - Use the "Send all digests now" button to validate end-to-end');
  console.log('');
  console.log('For Railway / production deployment, set these env vars instead of the JSON files:');
  console.log('  GMAIL_OAUTH_CLIENT_ID     = ' + client.client_id);
  console.log('  GMAIL_OAUTH_CLIENT_SECRET = ' + client.client_secret);
  console.log('  GMAIL_OAUTH_REFRESH_TOKEN = ' + tokens.refresh_token);
  console.log('  EQIS_MAILER_FROM          = EQIS <eqis@etrav.in>  (optional override)');
  console.log('');
}

main().catch(err => {
  console.error('Auth failed:', err.message);
  process.exit(1);
});
