// Rebuild the Review tab so its history section mirrors the SearchPulse
// history layout: date-range filters, quick buttons, paginated data-table.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const htmlPath = path.join(ROOT, 'dashboard', 'ui', 'index.html');
let src = fs.readFileSync(htmlPath, 'utf-8');

// Replace the existing Review tab BODY (between '<div class="tab-panel" id="tab-review">'
// and the closing of that panel) with a SearchPulse-history-styled layout.
const startMarker = '<div class="tab-panel" id="tab-review">';
const endMarker = '    </div>\n\n    <div class="tab-panel" id="tab-supplier-health">';
const s = src.indexOf(startMarker);
const e = src.indexOf(endMarker, s);
if (s === -1 || e === -1) {
  // No closing marker present — try a more lenient one
  const altEnd = src.indexOf('    </div>\n    <div class="tab-panel" id="tab-supplier-health">', s);
  if (s === -1 || altEnd === -1) {
    console.error('Could not locate Review tab boundaries');
    process.exit(1);
  }
  console.log('Using lenient end marker');
  // Use altEnd
}
const realEnd = (e !== -1) ? e : src.indexOf('    </div>\n    <div class="tab-panel" id="tab-supplier-health">', s);

const newPanel = [
'    <div class="tab-panel" id="tab-review">',
'      <div style="display:flex;align-items:baseline;gap:16px;margin-bottom:10px;">',
'        <h2 style="margin:0;">&#x1F50D; Review Engine <span style="font-size:12px;color:var(--text-dim);font-weight:400;">Flight INTL post-search Book\u2192Review-page audit</span></h2>',
'        <div id="review-status-pill" style="margin-left:auto;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;background:#eee;color:#666;">LOADING</div>',
'        <button onclick="loadReviewTab()" style="padding:6px 14px;border-radius:4px;background:var(--accent);color:white;font-size:11px;font-weight:600;cursor:pointer;border:none;white-space:nowrap;">&#x1F504; Refresh</button>',
'      </div>',
'',
'      <div id="review-summary-row" style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:18px;"></div>',
'',
'      <!-- Date filter row, mirrors the SearchPulse history layout -->',
'      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">',
'        <span style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;">Date Range:</span>',
'        <input type="date" id="reviewDateFrom" onchange="loadReviewHistory()" style="padding:5px 10px;border-radius:4px;background:var(--card);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:12px;">',
'        <span style="color:var(--text-dim);font-size:12px;">to</span>',
'        <input type="date" id="reviewDateTo" onchange="loadReviewHistory()" style="padding:5px 10px;border-radius:4px;background:var(--card);border:1px solid var(--border);color:var(--text);font-family:var(--mono);font-size:12px;">',
"        <button onclick=\"document.getElementById('reviewDateFrom').value=''; document.getElementById('reviewDateTo').value=''; loadReviewHistory();\" style=\"padding:5px 12px;border-radius:4px;background:var(--surface);border:1px solid var(--border);color:var(--text-dim);font-size:11px;cursor:pointer;\">Clear</button>",
'        <button onclick="reviewQuickDate(0)" style="padding:5px 10px;border-radius:4px;background:var(--surface);border:1px solid var(--border);color:var(--text);font-size:11px;cursor:pointer;">Today</button>',
'        <button onclick="reviewQuickDate(1)" style="padding:5px 10px;border-radius:4px;background:var(--surface);border:1px solid var(--border);color:var(--text);font-size:11px;cursor:pointer;">Yesterday</button>',
'        <button onclick="reviewQuickDate(7)" style="padding:5px 10px;border-radius:4px;background:var(--surface);border:1px solid var(--border);color:var(--text);font-size:11px;cursor:pointer;">Last 7 Days</button>',
'        <button onclick="reviewQuickDate(30)" style="padding:5px 10px;border-radius:4px;background:var(--surface);border:1px solid var(--border);color:var(--text);font-size:11px;cursor:pointer;">Last 30 Days</button>',
'      </div>',
'',
'      <div class="card">',
'        <table class="data-table" id="reviewHistoryTable">',
'          <thead><tr>',
'            <th>Date</th><th>Time</th><th>Sector</th><th>Airline / Flight</th><th>Fare</th>',
'            <th style="text-align:right;">Load ms</th><th>Verdict</th><th style="text-align:right;">Severity</th><th>Review URL</th><th style="text-align:right;">Action</th>',
'          </tr></thead>',
'          <tbody id="reviewHistoryBody"></tbody>',
'        </table>',
'      </div>',
'',
'      <h3 style="margin:24px 0 8px;font-size:15px;">Rotation buffer per route</h3>',
'      <div id="review-rotation-list" style="font-size:12px;font-family:Monaco,Menlo,monospace;"></div>',
'',
'      <h3 style="margin:24px 0 8px;font-size:15px;">7-day roll-up</h3>',
'      <table class="data-table" id="review-rollup-table" style="width:100%;border-collapse:collapse;">',
'        <thead><tr style="background:#fafafa;">',
'          <th style="padding:8px;text-align:left;font-size:11px;">Date</th>',
'          <th style="padding:8px;text-align:right;font-size:11px;">Attempts</th>',
'          <th style="padding:8px;text-align:right;font-size:11px;">OK%</th>',
'          <th style="padding:8px;text-align:right;font-size:11px;">Avg load ms</th>',
'          <th style="padding:8px;text-align:right;font-size:11px;">P95 load ms</th>',
'          <th style="padding:8px;text-align:right;font-size:11px;">Etrav issues</th>',
'          <th style="padding:8px;text-align:right;font-size:11px;">EQIS issues</th>',
'        </tr></thead>',
'        <tbody></tbody>',
'      </table>',
'    </div>',
'',
].join('\n');

src = src.slice(0, s) + newPanel + src.slice(realEnd);

// Inject the new loader helpers + history range loader. Replace the old
// loadReviewTab block with a richer one. We find the existing function and
// rebuild it.
const oldFnStart = src.indexOf('  function loadReviewTab() {');
const oldFnEnd = src.indexOf('  if (typeof loadReviewTab === "function") {', oldFnStart);
if (oldFnStart === -1 || oldFnEnd === -1) {
  console.log('  WARN: original loadReviewTab block not found; skipping JS upgrade');
} else {
  const replacement = [
'  function loadReviewTab() {',
'    var t = document.getElementById("tab-review");',
'    if (!t || !t.classList.contains("active")) return;',
'    fetch("/api/review/status").then(function(r){ return r.json(); }).then(function(s) {',
'      var pill = document.getElementById("review-status-pill");',
'      if (pill) {',
'        pill.textContent = s.enabled ? "ENABLED" : "DISABLED (env)";',
'        pill.style.background = s.enabled ? "#dcfce7" : "#fef3c7";',
'        pill.style.color      = s.enabled ? "#065f46" : "#92400e";',
'      }',
'      var sum = s.today || { total: 0, ok: 0, successRate: 0, avgLoadMs: 0, p95LoadMs: 0, etravIssues: 0, eqisIssues: 0 };',
'      var row = document.getElementById("review-summary-row");',
'      if (row) row.innerHTML = [',
'        _reviewCard("Attempts today",    sum.total),',
'        _reviewCard("Success rate",      (sum.successRate||0).toFixed(0) + "%", sum.successRate >= 90 ? "#0a7f3f" : sum.successRate >= 70 ? "#7a5400" : "#a40000"),',
'        _reviewCard("Etrav issues",      sum.etravIssues, sum.etravIssues ? "#a40000" : "#0a7f3f"),',
'        _reviewCard("EQIS issues",       sum.eqisIssues,  sum.eqisIssues  ? "#7a5400" : "#0a7f3f"),',
'        _reviewCard("Avg load ms",       sum.avgLoadMs, sum.avgLoadMs > 10000 ? "#7a5400" : "#0a7f3f"),',
'      ].join("");',
'    }).catch(function(){});',
'    fetch("/api/review/rotation").then(function(r){ return r.json(); }).then(function(data) {',
'      var div = document.getElementById("review-rotation-list");',
'      if (!div) return;',
'      var fi = data["flight-intl"] || {};',
'      var routes = Object.keys(fi);',
'      if (routes.length === 0) { div.innerHTML = \'<div style="color:#888;font-style:italic;">Rotation buffer empty — waiting for first Review attempt.</div>\'; return; }',
'      div.innerHTML = routes.map(function(rk) {',
'        var slot = fi[rk] || { recentPicks: [] };',
'        var picks = (slot.recentPicks || []).map(function(p) { return p.airline + " " + (p.flightCode || "") + " [" + (p.fareLabel || "?") + "]"; }).join(" \u00b7 ");',
'        return \'<div style="margin-bottom:4px;"><b>\' + rk + "</b>: " + (picks || "—") + "</div>";',
'      }).join("");',
'    }).catch(function(){});',
'    fetch("/api/review/history").then(function(r){ return r.json(); }).then(function(data) {',
'      var tbody = document.querySelector("#review-rollup-table tbody");',
'      if (!tbody) return;',
'      var days = data.days || [];',
'      if (days.length === 0) { tbody.innerHTML = \'<tr><td colspan="7" style="padding:14px;text-align:center;color:#888;font-style:italic;">No historical data yet.</td></tr>\'; return; }',
'      tbody.innerHTML = days.map(function(d) {',
'        var s = d.summary || {};',
'        return "<tr>" +',
'          \'<td style="padding:8px;font-size:12px;font-weight:600;">\' + d.date + "</td>" +',
'          \'<td style="padding:8px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">\' + (s.total || 0) + "</td>" +',
'          \'<td style="padding:8px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:\' + (s.successRate >= 90 ? "#0a7f3f" : s.successRate >= 70 ? "#7a5400" : "#a40000") + \';">\' + (s.successRate || 0).toFixed(0) + "%</td>" +',
'          \'<td style="padding:8px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">\' + (s.avgLoadMs || 0) + "</td>" +',
'          \'<td style="padding:8px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">\' + (s.p95LoadMs || 0) + "</td>" +',
'          \'<td style="padding:8px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:#a40000;">\' + (s.etravIssues || 0) + "</td>" +',
'          \'<td style="padding:8px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;color:#7a5400;">\' + (s.eqisIssues || 0) + "</td>" +',
'        "</tr>";',
'      }).join("");',
'    }).catch(function(){});',
'    loadReviewHistory();',
'  }',
'',
'  function reviewQuickDate(daysBack) {',
'    var to = new Date(); var from = new Date(); from.setDate(from.getDate() - daysBack);',
'    document.getElementById("reviewDateFrom").value = from.toISOString().split("T")[0];',
'    document.getElementById("reviewDateTo").value   = to.toISOString().split("T")[0];',
'    loadReviewHistory();',
'  }',
'',
'  function loadReviewHistory() {',
'    var from = document.getElementById("reviewDateFrom");',
'    var to   = document.getElementById("reviewDateTo");',
'    var fromIso = from && from.value ? from.value : new Date().toISOString().split("T")[0];',
'    var toIso   = to   && to.value   ? to.value   : new Date().toISOString().split("T")[0];',
'    var d1 = new Date(fromIso), d2 = new Date(toIso);',
'    if (isNaN(d1) || isNaN(d2)) return;',
'    var days = [];',
'    for (var t = d1.getTime(); t <= d2.getTime(); t += 86400000) days.push(new Date(t).toISOString().split("T")[0]);',
'    Promise.all(days.map(function(iso) {',
'      return fetch("/api/review/today?date=" + iso).then(function(r){ return r.json(); }).catch(function(){ return { date: iso, rows: [] }; });',
'    })).then(function(results) {',
'      var rows = [];',
'      results.forEach(function(r) { (r.rows || []).forEach(function(x) { rows.push(x); }); });',
'      rows.sort(function(a, b) { return String(b.startedAt).localeCompare(String(a.startedAt)); });',
'      var tbody = document.getElementById("reviewHistoryBody");',
'      if (!tbody) return;',
'      if (rows.length === 0) { tbody.innerHTML = \'<tr><td colspan="9" style="padding:18px;text-align:center;color:#888;font-style:italic;">No Review attempts in this range.</td></tr>\'; return; }',
'      tbody.innerHTML = rows.map(function(r) {',
'        var m = r.metrics || {}; var x = r.target || {};',
'        var startedAt = r.startedAt ? new Date(r.startedAt) : null;',
'        var datestr = startedAt ? startedAt.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "";',
'        var timestr = startedAt ? startedAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "";',
'        var color = _reviewVerdictColor(r.verdict);',
'        return "<tr>" +',
'          \'<td style="font-size:12px;">\' + datestr + "</td>" +',
'          \'<td style="font-size:11px;color:#666;font-family:Monaco,Menlo,monospace;">\' + timestr + "</td>" +',
'          \'<td style="font-size:12px;font-weight:600;">\' + (r.sector || "?") + "</td>" +',
'          \'<td style="font-size:12px;">\' + (x.airline || "—") + " <span style=\\"color:#888;\\">" + (x.flightCode || "") + "</span></td>" +',
'          \'<td style="font-size:12px;">\' + (x.fareLabel || "—") + " <span style=\\"color:#888;\\">₹" + (x.price || "—") + "</span></td>" +',
'          \'<td style="text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">\' + (m.loadMs != null ? m.loadMs : "—") + "</td>" +',
'          \'<td style="font-size:11px;font-weight:700;color:\' + color + \';">\' + (r.verdict || "?") + "</td>" +',
'          \'<td style="text-align:right;font-size:11px;color:\' + (r.severity === "P1" ? "#a40000" : r.severity === "P2" ? "#7a5400" : "#888") + \';">\' + (r.severity || "—") + "</td>" +',
'          \'<td style="font-size:10px;font-family:Monaco,Menlo,monospace;color:#666;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><a href="\' + (m.url || "#") + \'" target="_blank" style="color:#2563eb;">\' + (m.url || "—") + "</a></td>" +',
'        "</tr>";',
'      }).join("");',
'    });',
'  }',
'',
  ].join('\n');
  src = src.slice(0, oldFnStart) + replacement + src.slice(oldFnEnd);
  console.log('PASS  loadReviewTab() upgraded');
}

fs.writeFileSync(htmlPath, src);
console.log('PASS  index.html patched with SearchPulse-style Review history');
