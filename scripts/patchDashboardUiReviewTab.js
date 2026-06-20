// Patch dashboard/ui/index.html:
//  1. Insert a "Review" nav tab between History and Supplier Health.
//  2. Insert an empty tab-panel #tab-review before #tab-supplier-health.
//  3. Append the JS that fetches /api/review/* and renders into the panel.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const htmlPath = path.join(ROOT, 'dashboard', 'ui', 'index.html');
let src = fs.readFileSync(htmlPath, 'utf-8');

if (src.indexOf("switchTab('review')") !== -1) {
  console.log('Already patched - exiting');
  process.exit(0);
}

// 1. Insert nav tab between History and Supplier Health
const navNeedle = '    <div class="tab" onclick="switchTab(\'supplier-health\')">&#9992; Supplier Health</div>';
const navInsert = '    <div class="tab" onclick="switchTab(\'review\')">&#x1F50D; Review</div>\n';
if (src.indexOf(navNeedle) === -1) { console.error('nav anchor not found'); process.exit(1); }
src = src.replace(navNeedle, navInsert + navNeedle);

// 2. Insert empty tab-panel
const panelNeedle = '    <div class="tab-panel" id="tab-supplier-health">';
const panelHtml = [
'    <div class="tab-panel" id="tab-review">',
'      <div style="display:flex;align-items:baseline;gap:16px;margin-bottom:10px;">',
'        <h2 style="margin:0;">&#x1F50D; Review Engine <span style="font-size:12px;color:var(--text-dim);font-weight:400;">Flight INTL post-search Book\u2192Review-page audit</span></h2>',
'        <div id="review-status-pill" style="margin-left:auto;font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;background:#eee;color:#666;">LOADING</div>',
'      </div>',
'      <div id="review-summary-row" style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:18px;"></div>',
'      <h3 style="margin:18px 0 8px;font-size:15px;">Today\u2019s attempts</h3>',
'      <table class="data-table" id="review-today-table" style="width:100%;border-collapse:collapse;">',
'        <thead><tr style="background:#fafafa;">',
'          <th style="padding:8px;text-align:left;font-size:11px;">When</th>',
'          <th style="padding:8px;text-align:left;font-size:11px;">Sector</th>',
'          <th style="padding:8px;text-align:left;font-size:11px;">Airline / Flight</th>',
'          <th style="padding:8px;text-align:left;font-size:11px;">Fare</th>',
'          <th style="padding:8px;text-align:right;font-size:11px;">Load ms</th>',
'          <th style="padding:8px;text-align:left;font-size:11px;">Verdict</th>',
'          <th style="padding:8px;text-align:left;font-size:11px;">Review URL</th>',
'        </tr></thead>',
'        <tbody></tbody>',
'      </table>',
'      <h3 style="margin:24px 0 8px;font-size:15px;">Recent failures (last 24h)</h3>',
'      <div id="review-failures-list"></div>',
'      <h3 style="margin:24px 0 8px;font-size:15px;">Rotation buffer per route</h3>',
'      <div id="review-rotation-list" style="font-size:12px;font-family:Monaco,Menlo,monospace;"></div>',
'      <h3 style="margin:24px 0 8px;font-size:15px;">7-day history</h3>',
'      <table class="data-table" id="review-history-table" style="width:100%;border-collapse:collapse;">',
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
'',
].join('\n');
if (src.indexOf(panelNeedle) === -1) { console.error('panel anchor not found'); process.exit(1); }
src = src.replace(panelNeedle, panelHtml + panelNeedle);

// 3. Append the JS loader for the Review tab at the very end of the body's script section.
const scriptCloseNeedle = '\n</script>';
const reviewScript = [
'',
"  /* === Review Engine tab loader ===================================== */",
'  function _reviewFmtTime(iso) {',
'    if (!iso) return "";',
'    try { var d = new Date(iso); return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) + " " + d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }); }',
'    catch { return iso; }',
'  }',
'  function _reviewVerdictColor(v) {',
'    if (v === "REVIEW_OK") return "#0a7f3f";',
'    if (v === "PRICE_CHANGED" || v === "FARE_UNAVAILABLE" || v === "SESSION_EXPIRED" || v === "BANNER_ERROR") return "#a40000";',
'    if (v === "BOOK_BTN_MISSING" || v === "BOOK_CLICK_NO_NAV" || v === "REVIEW_LOAD_TIMEOUT" || v === "JS_ERROR" || v === "REVIEW_BROKEN") return "#7a5400";',
'    return "#666";',
'  }',
'  function _reviewCard(label, value, color) {',
'    color = color || "#0a0a0a";',
'    return \'<div style="border:1px solid #eee;border-radius:6px;padding:10px 12px;background:#fff;">\' +',
"      '<div style=\"font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.04em;font-weight:600;\">' + label + '</div>' +",
"      '<div style=\"font-size:22px;font-weight:700;color:' + color + ';margin-top:4px;font-variant-numeric:tabular-nums;\">' + value + '</div>' +",
'      \'</div>\';',
'  }',
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
'    fetch("/api/review/today").then(function(r){ return r.json(); }).then(function(data) {',
'      var rows = (data.rows || []).slice().reverse();',
'      var tbody = document.querySelector("#review-today-table tbody");',
'      if (!tbody) return;',
'      if (rows.length === 0) {',
'        tbody.innerHTML = \'<tr><td colspan="7" style="padding:18px;text-align:center;color:#888;font-style:italic;">No Review attempts captured today yet — waiting for next Flight INTL SUCCESS.</td></tr>\';',
'        return;',
'      }',
'      tbody.innerHTML = rows.map(function(r) {',
'        var m = r.metrics || {};',
'        var t = r.target || {};',
'        var verdictColor = _reviewVerdictColor(r.verdict);',
'        return "<tr>" +',
'          \'<td style="padding:8px;font-size:11px;color:#666;white-space:nowrap;">\' + _reviewFmtTime(r.startedAt) + "</td>" +',
'          \'<td style="padding:8px;font-size:12px;font-weight:600;">\' + (r.sector || "?") + "</td>" +',
'          \'<td style="padding:8px;font-size:12px;">\' + (t.airline || "—") + " <span style=\\"color:#888;\\">" + (t.flightCode || "") + "</span></td>" +',
'          \'<td style="padding:8px;font-size:12px;">\' + (t.fareLabel || "—") + " <span style=\\"color:#888;\\">₹" + (t.price || "—") + "</span></td>" +',
'          \'<td style="padding:8px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums;">\' + (m.loadMs != null ? m.loadMs : "—") + "</td>" +',
'          \'<td style="padding:8px;font-size:11px;font-weight:700;color:\' + verdictColor + \';">\' + (r.verdict || "?") + "</td>" +',
'          \'<td style="padding:8px;font-size:10px;font-family:Monaco,Menlo,monospace;color:#666;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\' + (m.url || "—") + "</td>" +',
'        "</tr>";',
'      }).join("");',
'    }).catch(function(){});',
'    fetch("/api/review/failures").then(function(r){ return r.json(); }).then(function(data) {',
'      var list = document.getElementById("review-failures-list");',
'      if (!list) return;',
'      var fails = data.failures || [];',
'      if (fails.length === 0) { list.innerHTML = \'<div style="padding:12px;color:#0a7f3f;font-weight:600;border:1px dashed #c8e7d3;border-radius:6px;text-align:center;">✓ No failures in the last 24h</div>\'; return; }',
'      list.innerHTML = fails.slice(0, 15).map(function(r) {',
'        var t = r.target || {};',
'        var m = r.metrics || {};',
'        return \'<div style="border:1px solid #eee;border-radius:6px;padding:8px 12px;margin-bottom:6px;display:flex;gap:12px;align-items:center;">\' +',
'          \'<span style="font-size:10px;color:#888;font-family:Monaco,Menlo,monospace;">\' + _reviewFmtTime(r.startedAt) + "</span>" +',
'          \'<span style="font-weight:600;font-size:12px;">\' + (r.sector || "?") + "</span>" +',
'          \'<span style="font-size:11px;color:#666;">\' + (t.airline || "—") + " " + (t.flightCode || "") + " · " + (t.fareLabel || "—") + "</span>" +',
'          \'<span style="margin-left:auto;font-size:11px;font-weight:700;color:\' + _reviewVerdictColor(r.verdict) + \';">\' + (r.verdict || "?") + "</span>" +',
'          (m.url ? \'<a href="\' + m.url + \'" target="_blank" style="font-size:10px;color:#2563eb;">→ open</a>\' : "") +',
'        "</div>";',
'      }).join("");',
'    }).catch(function(){});',
'    fetch("/api/review/rotation").then(function(r){ return r.json(); }).then(function(data) {',
'      var div = document.getElementById("review-rotation-list");',
'      if (!div) return;',
'      var fi = data["flight-intl"] || {};',
'      var routes = Object.keys(fi);',
'      if (routes.length === 0) { div.innerHTML = \'<div style="color:#888;font-style:italic;">Rotation buffer empty — waiting for first Review attempt.</div>\'; return; }',
'      div.innerHTML = routes.map(function(rk) {',
'        var slot = fi[rk] || { recentPicks: [] };',
'        var picks = (slot.recentPicks || []).map(function(p) { return p.airline + " " + (p.flightCode || "") + " [" + (p.fareLabel || "?") + "]"; }).join(" · ");',
'        return \'<div style="margin-bottom:4px;"><b>\' + rk + "</b>: " + (picks || "—") + "</div>";',
'      }).join("");',
'    }).catch(function(){});',
'    fetch("/api/review/history").then(function(r){ return r.json(); }).then(function(data) {',
'      var tbody = document.querySelector("#review-history-table tbody");',
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
'  }',
'  // Hook into the existing tab-switch flow if present',
'  if (typeof GLOBAL_DASHBOARD_LOADERS !== "undefined" && GLOBAL_DASHBOARD_LOADERS) {',
'    GLOBAL_DASHBOARD_LOADERS["review"] = loadReviewTab;',
'  }',
'  if (typeof loadReviewTab === "function") { try { loadReviewTab(); } catch (e) {} }',
].join('\n');
if (src.indexOf(scriptCloseNeedle) === -1) { console.error('script close not found'); process.exit(1); }
// Insert at LAST occurrence so it's at the end of the script block
const lastIdx = src.lastIndexOf(scriptCloseNeedle);
src = src.slice(0, lastIdx) + '\n' + reviewScript + '\n' + src.slice(lastIdx);

fs.writeFileSync(htmlPath, src);
console.log('OK: index.html patched with Review tab UI');
