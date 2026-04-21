/**
 * Google Drive storage for session recordings — OAuth user-account flow.
 *
 * - Uploads .webm / .mp4 session recordings to a shared Drive folder using a
 *   long-lived refresh token tied to a real user account (service accounts
 *   have no storage quota, so they can't own files; OAuth fixes that).
 * - Makes each file "Anyone with the link — viewer" so the dashboard iframe
 *   can embed it without per-request OAuth.
 * - Returns { fileId, previewUrl, webViewLink, size }.
 *
 * Auth (first match wins):
 *   1. GDRIVE_OAUTH_CLIENT_ID + GDRIVE_OAUTH_CLIENT_SECRET + GDRIVE_OAUTH_REFRESH_TOKEN env vars (Railway)
 *   2. state/gdrive-oauth-client.json + state/gdrive-oauth-token.json on disk (local dev)
 *
 * Required env to activate:
 *   RECORDING_STORAGE=gdrive
 *   GDRIVE_FOLDER_ID
 *   (plus the OAuth triplet above, or the local JSON files)
 *
 * Without RECORDING_STORAGE=gdrive this module is dormant — local dev keeps
 * writing .mp4 files to reports/recordings like before.
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const logger = require('./logger');

let _driveClient = null;
let _authError = null;

function loadOAuthConfig() {
  // 1) env vars (Railway)
  if (process.env.GDRIVE_OAUTH_CLIENT_ID
      && process.env.GDRIVE_OAUTH_CLIENT_SECRET
      && process.env.GDRIVE_OAUTH_REFRESH_TOKEN) {
    return {
      client_id: process.env.GDRIVE_OAUTH_CLIENT_ID,
      client_secret: process.env.GDRIVE_OAUTH_CLIENT_SECRET,
      refresh_token: process.env.GDRIVE_OAUTH_REFRESH_TOKEN,
    };
  }
  // 2) local files (dev)
  const clientPath = path.join(__dirname, '..', 'state', 'gdrive-oauth-client.json');
  const tokenPath = path.join(__dirname, '..', 'state', 'gdrive-oauth-token.json');
  if (fs.existsSync(clientPath) && fs.existsSync(tokenPath)) {
    const clientRaw = JSON.parse(fs.readFileSync(clientPath, 'utf-8'));
    const c = clientRaw.installed || clientRaw.web || clientRaw;
    const tok = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    if (!c.client_id || !c.client_secret) throw new Error('OAuth client JSON missing client_id/secret');
    if (!tok.refresh_token) throw new Error('OAuth token JSON missing refresh_token — run `node authorize-drive.js` first');
    return {
      client_id: c.client_id,
      client_secret: c.client_secret,
      refresh_token: tok.refresh_token,
    };
  }
  throw new Error('No Drive OAuth credentials found (tried GDRIVE_OAUTH_* env vars and state/gdrive-oauth-*.json)');
}

function getDriveClient() {
  if (_driveClient) return _driveClient;
  if (_authError) throw _authError;
  try {
    const cfg = loadOAuthConfig();
    const auth = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
    auth.setCredentials({ refresh_token: cfg.refresh_token });
    // The OAuth2 client auto-refreshes the access token as needed.
    _driveClient = google.drive({ version: 'v3', auth });
    return _driveClient;
  } catch (err) {
    _authError = err;
    throw err;
  }
}

function getFolderId() {
  const id = process.env.GDRIVE_FOLDER_ID;
  if (!id) throw new Error('GDRIVE_FOLDER_ID env var is not set');
  return id;
}

/**
 * Is Drive storage active in this environment?
 * Returns true only when RECORDING_STORAGE=gdrive AND folder id AND creds are present.
 * Used by sessionRecorder to decide whether to attempt upload.
 */
function isEnabled() {
  if ((process.env.RECORDING_STORAGE || '').toLowerCase() !== 'gdrive') return false;
  if (!process.env.GDRIVE_FOLDER_ID) return false;
  const hasEnvCreds = !!(process.env.GDRIVE_OAUTH_CLIENT_ID
    && process.env.GDRIVE_OAUTH_CLIENT_SECRET
    && process.env.GDRIVE_OAUTH_REFRESH_TOKEN);
  if (hasEnvCreds) return true;
  const clientPath = path.join(__dirname, '..', 'state', 'gdrive-oauth-client.json');
  const tokenPath = path.join(__dirname, '..', 'state', 'gdrive-oauth-token.json');
  return fs.existsSync(clientPath) && fs.existsSync(tokenPath);
}

/**
 * Upload a local recording file to Drive and make it publicly viewable.
 *
 * @param {string} localPath   Absolute path to the .webm or .mp4 file
 * @param {string} displayName Drive filename, e.g. "session-12345.webm"
 * @returns {Promise<{fileId, previewUrl, webViewLink, size}>}
 */
async function uploadRecording(localPath, displayName) {
  if (!fs.existsSync(localPath)) throw new Error('Local file not found: ' + localPath);
  const drive = getDriveClient();
  const folderId = getFolderId();
  const mimeType = displayName.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'video/webm';

  const createRes = await drive.files.create({
    requestBody: {
      name: displayName,
      parents: [folderId],
      mimeType,
    },
    media: {
      mimeType,
      body: fs.createReadStream(localPath),
    },
    fields: 'id,webViewLink,size',
    supportsAllDrives: true,
  });
  const fileId = createRes.data.id;

  // "Anyone with the link — viewer" so the dashboard iframe works without login
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });
  } catch (permErr) {
    logger.warn('[DRIVE] Failed to set anyone-can-view on ' + fileId + ': ' + permErr.message);
  }

  const previewUrl = 'https://drive.google.com/file/d/' + fileId + '/preview';
  const webViewLink = createRes.data.webViewLink || ('https://drive.google.com/file/d/' + fileId + '/view');
  const size = parseInt(createRes.data.size || '0', 10) || fs.statSync(localPath).size;

  logger.info('[DRIVE] Uploaded ' + displayName + ' -> ' + fileId + ' (' + Math.round(size / 1024) + 'KB) ' + previewUrl);
  return { fileId, previewUrl, webViewLink, size };
}

async function deleteRecording(fileId) {
  try {
    const drive = getDriveClient();
    await drive.files.delete({ fileId, supportsAllDrives: true });
    return true;
  } catch (err) {
    if (err && err.code === 404) return true;
    logger.warn('[DRIVE] Delete ' + fileId + ' failed: ' + err.message);
    return false;
  }
}

module.exports = {
  isEnabled,
  uploadRecording,
  deleteRecording,
  getDriveClient,
};
