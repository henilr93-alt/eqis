// ecdReportBuilder.js — Renders the canonical comparison run object to:
//   1. A standalone HTML report at reports/ecd/<runId>.html
//   2. A JSON sidecar at reports/ecd/<runId>.json
//
// The HTML mirrors the side-by-side table layout shown to the user during planning.

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const settings = require('../config/settings');
const { VERDICTS } = require('./verdictRules');

const REPORT_DIR = path.join(settings.REPORT_DIR, 'ecd');

function ensureDir() {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtINR(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

function badge(verdict, severity) {
  const colors = {
    [VERDICTS.ECD_CHEAPER]:      ['#0a7f3f', '#dff7e6'],
    [VERDICTS.NORMAL_CHEAPER]:   ['#a84a00', '#fff1dc'],
    [VERDICTS.EQUAL]:            ['#444',    '#eee'],
    [VERDICTS.DEFAULT_STOCKOUT]: ['#a40000', '#ffe0e0'],
    [VERDICTS.COMBO_UNMATCHED]:  ['#555',    '#dcdcdc'],
    [VERDICTS.ECD_BROKEN]:       ['#fff',    '#a40000'],
  };
  const [fg, bg] = colors[verdict] || ['#222', '#eee'];
  const sev = severity ? `<span style="margin-left:6px;font-weight:600;">[${severity}]</span>` : '';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${bg};color:${fg};font-size:12px;">${esc(verdict)}${sev}</span>`;
}

function renderSummary(s) {
  return `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
      <div style="padding:12px;border:1px solid #ddd;border-radius:8px;">
        <div style="font-size:12px;color:#666;">Combos compared</div>
        <div style="font-size:24px;font-weight:700;">${s.totalCombosCompared}</div>
      </div>
      <div style="padding:12px;border:1px solid #ddd;border-radius:8px;">
        <div style="font-size:12px;color:#666;">ECD cheaper</div>
        <div style="font-size:24px;font-weight:700;color:#0a7f3f;">${s.ecdCheaperPct}%</div>
        <div style="font-size:12px;color:#666;">${s.ecdCheaperCount} combos</div>
      </div>
      <div style="padding:12px;border:1px solid #ddd;border-radius:8px;">
        <div style="font-size:12px;color:#666;">Normal cheaper</div>
        <div style="font-size:24px;font-weight:700;color:#a84a00;">${s.normalCheaperPct}%</div>
        <div style="font-size:12px;color:#666;">${s.normalCheaperCount} combos</div>
      </div>
      <div style="padding:12px;border:1px solid #ddd;border-radius:8px;">
        <div style="font-size:12px;color:#666;">Avg ECD advantage</div>
        <div style="font-size:24px;font-weight:700;">${fmtINR(s.avgEcdAdvantageINR)}</div>
      </div>
    </div>
    <div style="margin-bottom:20px;font-size:13px;color:#555;">
      Stockouts: <b>${s.defaultStockoutCount}</b> · Unmatched combos: <b>${s.unmatchedComboCount}</b> · ECD broken: <b>${s.ecdBrokenCount}</b>
    </div>
  `;
}

function renderRows(rows) {
  let html = '';
  for (const r of rows) {
    const pax = r.pax ? `${r.pax.adults || '-'}A / ${r.pax.rooms || '-'}R` : '—';
    if (!r.combos || r.combos.length === 0) {
      html += `
        <tr>
          <td>${esc(r.destination || '—')}</td>
          <td>${esc(r.hotelName || '—')}</td>
          <td>${esc(r.checkin || '')} → ${esc(r.checkout || '')}</td>
          <td>${pax}</td>
          <td colspan="4" style="color:#888;">${esc(r.ecdStatus || 'no combos')} ${r.error ? '— ' + esc(r.error) : ''}</td>
          <td>${badge(r.topVerdict, r.severity)}</td>
        </tr>`;
      continue;
    }
    for (let i = 0; i < r.combos.length; i++) {
      const c = r.combos[i];
      const rowSpan = i === 0 ? r.combos.length : 0;
      const firstCols = i === 0
        ? `<td rowspan="${rowSpan}">${esc(r.destination || '—')}</td>
           <td rowspan="${rowSpan}">${esc(r.hotelName || '—')}</td>
           <td rowspan="${rowSpan}">${esc(r.checkin || '')} → ${esc(r.checkout || '')}</td>
           <td rowspan="${rowSpan}">${pax}</td>`
        : '';
      const comboCell = `${esc(c.roomCategory || '—')} + ${esc(c.mealPlan || '—')}`;
      const diffCell = (c.diff && c.diff.pct != null)
        ? `${c.diff.pct > 0 ? '+' : ''}${c.diff.pct}%`
        : '—';
      html += `
        <tr>
          ${firstCols}
          <td>${comboCell}</td>
          <td>${fmtINR(c.ecd?.totalPrice)}</td>
          <td>${fmtINR(c.normal?.totalPrice)}</td>
          <td>${diffCell}</td>
          <td>${badge(c.verdict, c.severity)}</td>
        </tr>`;
    }
  }
  return html;
}

function renderHtml(run) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>ECD Comparison — ${esc(run.runId)}</title>
<style>
  body { font: 14px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #222; margin: 24px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 18px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: top; text-align: left; }
  th { background: #fafafa; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #555; }
  tr:hover { background: #fcfcfc; }
</style></head><body>
  <h1>ECD Hotels Comparison</h1>
  <div class="sub">Run ID: <b>${esc(run.runId)}</b> · ${esc(run.timestamp)} · Destinations: ${esc((run.destinations || []).join(', '))}</div>
  ${renderSummary(run.summary || {})}
  <table>
    <thead><tr>
      <th>Destination</th><th>Hotel</th><th>Dates</th><th>Pax/Rooms</th>
      <th>Room + Meal</th><th>ECD Price</th><th>Normal Price</th><th>Δ</th><th>Verdict</th>
    </tr></thead>
    <tbody>
      ${renderRows(run.hotelComparisons || [])}
    </tbody>
  </table>
</body></html>`;
}

function writeReports(run) {
  ensureDir();
  const stem = run.runId || `ECD-${Date.now()}`;
  const jsonPath = path.join(REPORT_DIR, `${stem}.json`);
  const htmlPath = path.join(REPORT_DIR, `${stem}.html`);
  fs.writeFileSync(jsonPath, JSON.stringify(run, null, 2));
  fs.writeFileSync(htmlPath, renderHtml(run));
  logger.info(`[ECD-REPORT] Wrote ${jsonPath} and ${htmlPath}`);
  return { jsonPath, htmlPath };
}

module.exports = { writeReports, renderHtml };
