const fs = require('fs');
const path = require('path');

class UrlTracker {
  constructor(runId) {
    this.runId = runId;
    this.log = [];
  }

  async capture(page, stepName, metadata = {}) {
    const url = page.url();
    let parsed;
    try { parsed = new URL(url); } catch { parsed = { origin: '', pathname: url, search: '', searchParams: new URLSearchParams() }; }

    const entry = {
      step: stepName,
      url,
      origin: parsed.origin,
      pathname: parsed.pathname,
      queryString: parsed.search,
      searchParams: extractSearchParams(parsed.searchParams),
      timestamp: new Date().toISOString(),
      ...metadata,
    };

    this.log.push(entry);
    return entry;
  }

  async captureWithHash(page, stepName) {
    const entry = await this.capture(page, stepName);
    const hash = await page.evaluate(() => window.location.hash);
    entry.hash = hash;
    entry.fullUrlWithHash = entry.url + (hash && !entry.url.includes('#') ? hash : '');
    return entry;
  }

  getUrlForStep(stepName) {
    return this.log.find(e => e.step === stepName)?.url || null;
  }

  getAllUrls() {
    return this.log;
  }

  async saveToFile() {
    const dir = path.join(__dirname, '..', 'reports', this.runId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `url-log-${this.runId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(this.log, null, 2));
    return filePath;
  }

  toHtmlTable() {
    if (this.log.length === 0) return '<p style="color:#888;">No URLs captured.</p>';
    const rows = this.log.map(e => `
      <tr>
        <td style="color:#888; font-size:11px; white-space:nowrap;">${e.timestamp.slice(11, 19)}</td>
        <td style="color:#ECECEC; font-size:12px;">${escapeHtml(e.step)}</td>
        <td style="font-size:11px; font-family:monospace; word-break:break-all;">
          <a href="${escapeHtml(e.url)}" target="_blank" style="color:#1A73E8; text-decoration:none;">
            ${escapeHtml(e.url.length > 100 ? e.url.slice(0, 100) + '...' : e.url)}
          </a>
        </td>
        <td style="font-size:10px; color:#666; font-family:monospace;">${escapeHtml(e.queryString || '-')}</td>
      </tr>
    `).join('');

    return `
      <table style="width:100%; border-collapse:collapse; font-size:12px;">
        <thead>
          <tr style="border-bottom:1px solid #333;">
            <th style="text-align:left; color:#888; padding:4px 8px;">Time</th>
            <th style="text-align:left; color:#888; padding:4px 8px;">Step</th>
            <th style="text-align:left; color:#888; padding:4px 8px;">URL</th>
            <th style="text-align:left; color:#888; padding:4px 8px;">Query Params</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }
}

function extractSearchParams(searchParams) {
  const known = ['from', 'to', 'origin', 'destination', 'depart', 'return',
    'adults', 'children', 'infants', 'class', 'cabin', 'tripType',
    'city', 'checkin', 'checkout', 'rooms', 'dest'];
  const extracted = {};
  for (const key of known) {
    const val = searchParams.get(key) || searchParams.get(key.toLowerCase());
    if (val) extracted[key] = val;
  }
  return Object.keys(extracted).length > 0 ? extracted : null;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { UrlTracker };
