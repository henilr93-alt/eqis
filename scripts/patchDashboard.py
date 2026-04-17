#!/usr/bin/env python3
"""
Re-apply all dashboard UI patches to index.html after restore from backup.
Run from eqis/ directory: python3 scripts/patchDashboard.py
"""
import re

INDEX = 'dashboard/ui/index.html'

with open(INDEX, 'r') as f:
    c = f.read()

patches_applied = 0

# ===== PATCH 1: Zipy diagnostics panel div =====
old = '    <!-- TAB 4: ZIPY -->\n    <div class="tab-panel" id="tab-zipy">\n      <div class="grid-4"'
new = '    <!-- TAB 4: ZIPY -->\n    <div class="tab-panel" id="tab-zipy">\n      <div id="zipy-diagnostics-panel" style="display:none;background:linear-gradient(135deg,#1a1a2e,#16213e);border:2px solid #FF9500;border-radius:12px;padding:20px;margin-bottom:16px;"></div>\n      <div class="grid-4"'
if old in c:
    c = c.replace(old, new, 1)
    patches_applied += 1
    print("P1: Zipy diagnostics panel div")

# ===== PATCH 2: Zipy stat cards from zipySummary =====
old_zipy_stats = """    document.getElementById('zipy-sessions').textContent = '\u2014';
    document.getElementById('zipy-bugs').textContent = '\u2014';
    document.getElementById('zipy-completion').textContent = '\u2014';
    document.getElementById('zipy-mirror').textContent = '\u2014';"""
new_zipy_stats = """    // Populate Zipy stat cards from zipySummary
    if (metrics.zipySummary) {
      document.getElementById('zipy-sessions').textContent = metrics.zipySummary.sessionsToday || 0;
      document.getElementById('zipy-bugs').textContent = metrics.zipySummary.bugsToday || 0;
      document.getElementById('zipy-completion').textContent = (metrics.zipySummary.completionRate || 0) + '%';
      document.getElementById('zipy-mirror').textContent = metrics.zipySummary.mirrorsActive || 0;
    } else {
      document.getElementById('zipy-sessions').textContent = '\u2014';
      document.getElementById('zipy-bugs').textContent = '\u2014';
      document.getElementById('zipy-completion').textContent = '\u2014';
      document.getElementById('zipy-mirror').textContent = '\u2014';
    }"""
if old_zipy_stats in c:
    c = c.replace(old_zipy_stats, new_zipy_stats, 1)
    patches_applied += 1
    print("P2: Zipy stat cards")

# ===== PATCH 3: Zipy diagnostics panel rendering (after zipyCompletionRate chart) =====
old_zipy_render = """    if (metrics.zipyCompletionRate) {
      renderChart('chartZipyCompletion', 'line', metrics.zipyCompletionRate, CHART_DEFAULTS);
    }

    const routesTbody"""
new_zipy_render = """    if (metrics.zipyCompletionRate) {
      renderChart('chartZipyCompletion', 'line', metrics.zipyCompletionRate, CHART_DEFAULTS);
    }

    // Render Zipy diagnostics panel if harvest is blocked
    const diagPanel = document.getElementById('zipy-diagnostics-panel');
    if (metrics.zipyDiagnostics && diagPanel) {
      const d = metrics.zipyDiagnostics;
      diagPanel.style.display = 'block';
      const bMsg = d.blockers && d.blockers.length > 0 ? d.blockers[0].message : '';
      diagPanel.innerHTML = '<h3 style="color:#FF9500;margin:0 0 12px 0;font-size:15px">\\u26A0\\uFE0F ZIPY ENGINE DIAGNOSTICS \\u2014 HARVEST BLOCKED</h3><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px"><div style="background:#141414;border-radius:8px;padding:10px"><div style="color:#888;font-size:10px;text-transform:uppercase">Login</div><div style="color:#FF9500;font-size:15px;font-weight:bold">' + (d.loginStatus || 'unknown') + '</div></div><div style="background:#141414;border-radius:8px;padding:10px"><div style="color:#888;font-size:10px;text-transform:uppercase">Harvest</div><div style="color:#FF3B30;font-size:15px;font-weight:bold">' + (d.status || 'failed').toUpperCase() + '</div></div><div style="background:#141414;border-radius:8px;padding:10px"><div style="color:#888;font-size:10px;text-transform:uppercase">Clickable Divs</div><div style="color:#FFCC00;font-size:15px;font-weight:bold">' + (d.domStats ? d.domStats.clickableDivs : 0) + '</div></div><div style="background:#141414;border-radius:8px;padding:10px"><div style="color:#888;font-size:10px;text-transform:uppercase">Session Elements</div><div style="color:#FFCC00;font-size:15px;font-weight:bold">' + (d.domStats ? d.domStats.sessionElements : 0) + '</div></div></div>' + (bMsg ? '<div style="margin-top:10px;background:#2a1010;border:1px solid #FF3B30;border-radius:8px;padding:10px"><div style="color:#FF3B30;font-weight:bold;font-size:11px;margin-bottom:4px">BLOCKER</div><div style="color:#ff8888;font-size:12px">' + bMsg + '</div></div>' : '') + '<div style="margin-top:6px;color:#34AADC;font-size:11px;word-break:break-all">Page: ' + (d.currentUrl || 'N/A') + '</div>';
    } else if (diagPanel) { diagPanel.style.display = 'none'; }

    const routesTbody"""
if old_zipy_render in c:
    c = c.replace(old_zipy_render, new_zipy_render, 1)
    patches_applied += 1
    print("P3: Zipy diagnostics rendering")

# ===== PATCH 4: History table header — 4 subcategory columns =====
old_header = '<thead><tr><th>Type</th><th>Date</th><th>Time</th><th>Size</th><th style="text-align:right;">Cost</th><th>Tokens</th><th>Filename</th><th style="text-align:right;">Action</th></tr></thead>'
new_header = '<thead><tr><th>Type</th><th>Date</th><th>Time</th><th>Flight DOM</th><th>Flight INTL</th><th>Hotel DOM</th><th>Hotel INTL</th><th>Size</th><th style="text-align:right;">Cost</th><th>Tokens</th><th>Filename</th><th style="text-align:right;">Action</th></tr></thead>'
if old_header in c:
    c = c.replace(old_header, new_header, 1)
    patches_applied += 1
    print("P4: History header — 4 columns")

# ===== PATCH 5: History row rendering with 4 subcategory cells =====
# Find renderHistoryTable and add buildSubcatCell helper + 4 cell rendering
old_render = """function renderHistoryTable(reports, pagination) {"""
helper_and_render = """  // Helper: build a cell for a subcategory (domestic/international flight/hotel)
  function buildSubcatCell(subcat) {
    if (!subcat || (!subcat.searches || !subcat.searches.length) && !subcat.hasResults && !subcat.zeroRoutes) {
      return '<td style="color:var(--text-muted);text-align:center;font-size:11px;">&mdash;</td>';
    }
    if (subcat.searches && subcat.searches.length > 0) {
      return '<td style="text-align:center;font-size:11px;">' + subcat.searches.map(function(s) {
        var ltColor = s.loadTimeMs > 20000 ? '#FF3B30' : s.loadTimeMs > 8000 ? '#FF9500' : '#34C759';
        var icon = s.results > 0 ? '&#x2705;' : '&#x274C;';
        var ltSec = (s.loadTimeMs / 1000).toFixed(1);
        return '<div style="margin:1px 0;"><span style="color:' + (s.results > 0 ? '#34C759' : '#FF3B30') + ';font-weight:bold;">' + icon + ' ' + s.results + '</span> <span style="color:' + ltColor + ';font-weight:600;">' + ltSec + 's</span></div>';
      }).join('') + '</td>';
    }
    if (subcat.hasResults) {
      var ltColor = subcat.avgLoadMs > 20000 ? '#FF3B30' : subcat.avgLoadMs > 8000 ? '#FF9500' : '#34C759';
      return '<td style="text-align:center;"><span style="color:#34C759;font-weight:bold;">&#x2705; ' + subcat.results + '</span><br><span style="color:' + ltColor + ';font-size:11px;">' + (subcat.avgLoadMs/1000).toFixed(1) + 's</span></td>';
    }
    if (subcat.zeroRoutes > 0) {
      return '<td style="text-align:center;"><span style="color:#FF3B30;font-weight:bold;">&#x274C; 0</span><br><span style="color:#FF3B30;font-size:10px;">' + subcat.zeroRoutes + ' zero</span></td>';
    }
    return '<td style="color:var(--text-muted);text-align:center;">&mdash;</td>';
  }

function renderHistoryTable(reports, pagination) {"""
if old_render in c:
    c = c.replace(old_render, helper_and_render, 1)
    patches_applied += 1
    print("P5: buildSubcatCell helper")

# ===== PATCH 6: Add subcategory cells to each history row =====
# Find the row template and add 4 cells before Size column
old_row = """    return `
    <tr>
      <td><span class="badge ${r.type}">${r.type.toUpperCase()}</span></td>
      <td class="mono">${r.date || '\u2014'}</td>
      <td class="mono">${r.time || '\u2014'}</td>
      <td style="color:var(--text-dim);">${r.sizeKb}KB</td>"""
new_row = """    // SearchPulse: 4 subcategories
    const sp = r.cost?.searchPulse;
    let flightDomCell, flightIntlCell, hotelDomCell, hotelIntlCell;
    if (r.type === 'searchpulse' && sp) {
      flightDomCell = buildSubcatCell(sp.flight?.domestic);
      flightIntlCell = buildSubcatCell(sp.flight?.international);
      hotelDomCell = buildSubcatCell(sp.hotel?.domestic);
      hotelIntlCell = buildSubcatCell(sp.hotel?.international);
    } else {
      flightDomCell = '<td style="color:var(--text-muted);text-align:center;">&mdash;</td>';
      flightIntlCell = '<td style="color:var(--text-muted);text-align:center;">&mdash;</td>';
      hotelDomCell = '<td style="color:var(--text-muted);text-align:center;">&mdash;</td>';
      hotelIntlCell = '<td style="color:var(--text-muted);text-align:center;">&mdash;</td>';
    }
    return `
    <tr>
      <td><span class="badge ${r.type}">${r.type.toUpperCase()}</span></td>
      <td class="mono">${r.date || '\u2014'}</td>
      <td class="mono">${r.time || '\u2014'}</td>
      ${flightDomCell}
      ${flightIntlCell}
      ${hotelDomCell}
      ${hotelIntlCell}
      <td style="color:var(--text-dim);">${r.sizeKb}KB</td>"""
if old_row in c:
    c = c.replace(old_row, new_row, 1)
    patches_applied += 1
    print("P6: History row — 4 subcategory cells")

# ===== PATCH 7: Performance chart descriptions =====
chart_descs = [
    ('Search Health Over Time', 'Search Health Over Time</div><div style="color:#888;font-size:11px;margin-top:2px;">Are flight & hotel searches working? Higher = better. 4=All Good, 3=Minor Issue, 2=Problems, 1=Down</div>'),
    ('Result Load Time (ms)', 'How Fast Are Search Results?</div><div style="color:#888;font-size:11px;margin-top:2px;">Time taken to show results. Below red line (5s) = good. Spikes mean the platform is slow for agents.</div>'),
    ('Bugs Found Per Day', 'Bugs Found Per Day</div><div style="color:#888;font-size:11px;margin-top:2px;">Bugs detected during booking tests. Red (P0) = blocks bookings. Orange (P1) = major issue. Yellow (P2) = minor.</div>'),
    ('Bug Severity Split', 'Bug Severity Split</div><div style="color:#888;font-size:11px;margin-top:2px;">Breakdown of all bugs by severity. More red = more critical issues needing urgent fixes.</div>'),
    ('Scenario Type Split', 'What Routes Are Being Tested?</div><div style="color:#888;font-size:11px;margin-top:2px;">Mix of domestic, international, roundtrip &amp; mirror tests. Should be ~50/50 domestic/intl per CEO directive.</div>'),
    ('Run Health Distribution', 'Test Pass/Fail Rate</div><div style="color:#888;font-size:11px;margin-top:2px;">How many tests passed vs had warnings or failures. Green = passed. Yellow = warning. Red = failed.</div>'),
    ('Token Usage / Day', 'AI Cost Per Day</div><div style="color:#888;font-size:11px;margin-top:2px;">Tokens used by Claude AI for evaluating searches &amp; bugs. More tokens = higher cost. Budget: $50/day max.</div>'),
    ('Filter Pass Rate %', 'Do Search Filters Work?</div><div style="color:#888;font-size:11px;margin-top:2px;">When agents use filters (price, stops, star rating), do they work correctly? 100% = all filters working.</div>'),
    ('Top Routes Tested', 'Most Tested Routes</div><div style="color:#888;font-size:11px;margin-top:2px;">Which flight routes have been tested the most. Helps ensure coverage across all popular routes.</div>'),
]
for old_title, new_title in chart_descs:
    old_str = f'<div class="card-title">{old_title}</div>'
    new_str = f'<div class="card-title">{new_title}'
    if old_str in c:
        c = c.replace(old_str, new_str, 1)
        patches_applied += 1

print(f"P7: Performance chart descriptions ({len(chart_descs)} charts)")

# ===== PATCH 8: Split SearchPulse into 4 sub-engines on Live tab =====
old_engines = """    { stateKey: 'searchPulse', costKey: 'searchpulse', runKey: 'lastSearchPulseRun', totalKey: 'totalSearchPulseRuns', name: 'Search Pulse Engine', desc: `Every ${int.searchPulseMinutes || '?'} min \u2014 search + results`, field: 'health' },
    { stateKey: 'journey',"""
new_engines = """    { stateKey: 'searchPulse', costKey: 'searchpulse', runKey: 'lastSearchPulseRun', totalKey: 'totalSearchPulseRuns', name: '&#x2708;&#xFE0F; SP \\u2014 Airline Domestic', desc: `Every ${int.searchPulseMinutes || '?'} min \\u2014 domestic flight searches`, field: 'health', parentEngine: 'searchPulse' },
    { stateKey: 'searchPulse', costKey: 'searchpulse', runKey: 'lastSearchPulseRun', totalKey: 'totalSearchPulseRuns', name: '&#x2708;&#xFE0F; SP \\u2014 Airline International', desc: `Every ${int.searchPulseMinutes || '?'} min \\u2014 intl flight searches`, field: 'health', parentEngine: 'searchPulse' },
    { stateKey: 'searchPulse', costKey: 'searchpulse', runKey: 'lastSearchPulseRun', totalKey: 'totalSearchPulseRuns', name: '&#x1F3E8; SP \\u2014 Hotels Domestic', desc: `Every ${int.searchPulseMinutes || '?'} min \\u2014 domestic hotel searches`, field: 'health', parentEngine: 'searchPulse' },
    { stateKey: 'searchPulse', costKey: 'searchpulse', runKey: 'lastSearchPulseRun', totalKey: 'totalSearchPulseRuns', name: '&#x1F3E8; SP \\u2014 Hotels International', desc: `Every ${int.searchPulseMinutes || '?'} min \\u2014 intl hotel searches`, field: 'health', parentEngine: 'searchPulse' },
    { stateKey: 'journey',"""
if old_engines in c:
    c = c.replace(old_engines, new_engines, 1)
    patches_applied += 1
    print("P8: Live tab — 4 SearchPulse sub-engines")

# ===== PATCH 9: Toggle button uses parentEngine for sub-engines =====
old_toggle = """      <button onclick="toggleEngine('${e.stateKey}', ${btnAction})\""""
new_toggle = """      <button onclick="toggleEngine('${e.parentEngine || e.stateKey}', ${btnAction})\""""
if old_toggle in c:
    c = c.replace(old_toggle, new_toggle, 1)
    patches_applied += 1
    print("P9: Toggle button parentEngine")

# ===== PATCH 10: Fix colspan for empty table =====
c = c.replace('colspan="8"', 'colspan="12"')

with open(INDEX, 'w') as f:
    f.write(c)

print(f"\nTotal patches applied: {patches_applied}")
print("Dashboard patched successfully!")
