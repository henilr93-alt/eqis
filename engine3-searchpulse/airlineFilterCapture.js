// engine3-searchpulse/airlineFilterCapture.js
// Captures the airline filter sidebar on Etrav flight results page.
// Returns { screenshotPath, airlines: [{ name, count }] } or null if not found.
// Used by Flight INTL on SUCCESS to feed Supplier Health tab + per-search embed.

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

function slugify(s) {
  return String(s || 'sector').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/**
 * Locate the airline filter, mark it, return parsed airlines.
 * Done in a single page.evaluate so the marker stays on the DOM until we screenshot it.
 * Strategy: try multiple selector patterns + Etrav-specific guesses + result-card fallback.
 */
async function _markAndParseAirlineFilter(page) {
  return await page.evaluate(() => {
    // Diagnostic counts so we know what we DID see on the page
    const diag = {
      checkboxes: document.querySelectorAll('input[type=checkbox]').length,
      asides: document.querySelectorAll('aside').length,
      filterClassEls: document.querySelectorAll('[class*="filter" i]').length,
      airlineClassEls: document.querySelectorAll('[class*="airline" i]').length,
      carrierClassEls: document.querySelectorAll('[class*="carrier" i]').length,
      accordionCards: document.querySelectorAll('.accordion_container, .flight_search_result').length,
      selectAllEls: Array.from(document.querySelectorAll('*')).filter(e => /^select all$/i.test((e.textContent || '').trim())).length,
    };

    let filterEl = null;

    // BEST signal: Etrav's expanded Airlines dropdown contains "Select All" text.
    // Find that text → walk up to its panel container.
    const selectAllNodes = Array.from(document.querySelectorAll('*')).filter(e => {
      const t = (e.textContent || '').trim();
      return /^select all$/i.test(t) && e.children.length <= 1;
    });
    for (const sa of selectAllNodes) {
      let el = sa;
      for (let i = 0; i < 10 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // Panel should have multiple checkboxes / labels / div rows below
        const cbs = el.querySelectorAll('input[type=checkbox], [class*="checkbox" i]').length;
        const labelLike = el.querySelectorAll('label, [role="checkbox"], li').length;
        const innerText = (el.innerText || '').toLowerCase();
        if ((cbs >= 3 || labelLike >= 3) && innerText.includes('select all')) {
          filterEl = el; break;
        }
      }
      if (filterEl) break;
    }

    // 2026-06-02 v2: HARDENED Strategy 1 — find any tall container (h>=200px,
    // w<=700px) that has at least 3 checkboxes AND at least 3 text rows that
    // look like real airline names (mixed-case, 3-30 chars, lowercase chars
    // present). This is strict enough to reject Etrav's filter BUTTON BAR
    // (which is ~32px tall with uppercase one-word labels) while still
    // catching the airline dropdown panel even when "Select All" text isn't
    // present or is rendered as an icon.
    if (!filterEl) {
      const SKIP_RX = /^(airlines?|airline|select all|none|reset|apply|filter|filters|stops?|cabin|class|price|departure|arrival|sort|by|cheapest|fastest|best|non stop|nonstop|direct|one way|round trip|roundtrip|multi city|onward|return|host search|roundtrip fare)$/i;
      const candidates = Array.from(document.querySelectorAll('div, ul, ol, section, aside, fieldset'));
      let bestEl = null;
      let bestScore = -1;
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        // Reject button bars (too short) and full-page containers (too wide/tall)
        if (r.width === 0 || r.height < 200) continue;
        if (r.width > 700 || r.height > 1500) continue;
        const cbs = el.querySelectorAll('input[type=checkbox], [class*="checkbox" i], [role="checkbox"]').length;
        if (cbs < 3) continue;
        // Count "airline-shaped" text rows
        const rows = el.querySelectorAll('label, li, [role="checkbox"]');
        let airlineLike = 0;
        for (const rr of rows) {
          let t = (rr.innerText || '').trim().replace(/\s+/g, ' ');
          if (!t) continue;
          // strip trailing "Only" / count
          t = t.replace(/\bonly\b\s*$/i, '').replace(/\s*\(\d+\)\s*$/, '').trim();
          if (t.length < 3 || t.length > 30) continue;
          if (!/[a-z]/.test(t)) continue; // must contain lowercase
          if (SKIP_RX.test(t)) continue;
          airlineLike++;
        }
        if (airlineLike < 3) continue;
        // Score: prefer panels with more airline-like rows but smaller area
        const score = airlineLike * 10 - (r.width * r.height) / 100000;
        if (score > bestScore) { bestScore = score; bestEl = el; }
      }
      if (bestEl) filterEl = bestEl;
    }

    // Parse airlines from filter element — accept BOTH "Name (42)" AND bare "Name"
    // (Etrav's expanded dropdown uses bare names with checkboxes, no counts)
    const parseRows = (root) => {
      // Skip non-airline UI labels that appear inside the dropdown.
      // Expanded 2026-06-02 to catch Etrav form labels leaking into parser
      // when broader fallback strategies hit a wide container.
      const SKIP = new Set([
        'airlines', 'airline', 'select all', 'only', 'reset', 'apply',
        'price', 'departure', 'arrival', 'stops', 'duration', 'sort by',
        'cheapest', 'fastest', 'best', 'non stop', 'one way', 'round trip',
        // Etrav form labels that leak from the page header
        'host search', 'roundtrip fare', 'round trip fare', 'where from', 'where to',
        'multi city', 'roundtrip', 'flight', 'flights', 'hotel', 'hotels',
        'search flights', 'search hotels', 'modify search', 'edit search',
        'flight no', 'flight number', 'class', 'cabin class', 'traveller', 'travellers',
        'sort', 'filter', 'filters', 'reset all', 'clear all',
        'none', 'null', 'n/a', 'na', 'unknown', '-', '--', '...',
      ]);
      const rowEls = root.querySelectorAll('label, li, [role="checkbox"], [class*="checkbox" i], div, span');
      const airlines = [];
      const seen = new Set();
      // 2026-06-05 fix: regex catches "Airlines Select All", "Select-All",
      // "Select all (12)" and similar control-row variants that the exact-
      // match SKIP set misses. Observed 52+ occurrences in supplierHealth.json.
      const SELECT_ALL_RX = /select[\s-]*all/i;
      for (const r of rowEls) {
        let raw = (r.innerText || '').trim().replace(/\s+/g, ' ');
        if (!raw || raw.length > 80) continue;
        // Strip trailing "Only" link that Etrav appends to each row
        raw = raw.replace(/\bonly\b\s*$/i, '').trim();
        let name = raw;
        let count = 1; // default when no count is shown in the dropdown
        const m = raw.match(/^(.+?)\s*[\(\-]\s*(\d+)\s*\)?\s*$/);
        if (m) {
          name = m[1].trim();
          count = parseInt(m[2], 10) || 1;
        }
        name = name.replace(/[:\-•]\s*$/, '').trim();
        if (!name || name.length < 2 || name.length > 40) continue;
        const lower = name.toLowerCase();
        if (SKIP.has(lower)) continue;
        // Drop the Select-All control row in all its observed variants
        if (SELECT_ALL_RX.test(lower)) continue;
        // Must contain at least one letter (not just numbers)
        if (!/[a-z]/i.test(name)) continue;
        if (seen.has(lower)) continue;
        seen.add(lower);
        airlines.push({ name, count });
      }
      // 2026-06-05 fix: drop concatenation artifacts where the DOM walker
      // grabbed a parent container holding two adjacent airline labels (e.g.
      // "Air India Vietjet" when only "Air India" and "Vietjet" are real
      // rows). Any captured name that strictly contains another captured
      // name as a whole-word prefix or suffix is treated as the parent
      // container's combined text and dropped.
      const deduped = airlines.filter((a, idx) => {
        for (let j = 0; j < airlines.length; j++) {
          if (j === idx) continue;
          const other = airlines[j].name;
          if (other.length >= a.name.length) continue;
          const lowerA = a.name.toLowerCase();
          const lowerO = other.toLowerCase();
          // Whole-word containment at start, end, or middle (with a space)
          if (lowerA === lowerO + ' ' + lowerA.slice(lowerO.length + 1)) continue;
          if (lowerA.startsWith(lowerO + ' ') || lowerA.endsWith(' ' + lowerO)
              || lowerA.includes(' ' + lowerO + ' ')) {
            return false; // a is a concatenation containing other
          }
        }
        return true;
      });
      return deduped;
    };

    if (filterEl) {
      filterEl.setAttribute('data-eqis-airline-filter', '1');
      const airlines = parseRows(filterEl);
      if (airlines.length > 0) {
        const r = filterEl.getBoundingClientRect();
        return {
          found: true, source: 'filter',
          airlines, diag,
          bbox: { x: r.x, y: r.y, w: r.width, h: r.height },
        };
      }
    }

    // FALLBACK: derive airlines from result cards (.accordion_container)
    // Each card represents one flight; we count cards per airline name.
    // Reject UI labels (trip type badges, cabin labels, etc.) — they aren't airlines.
    const DENY_LABELS = new Set([
      'one way', 'oneway', 'one-way', 'round trip', 'roundtrip', 'round-trip',
      'multi city', 'multicity', 'multi-city',
      'direct', 'non stop', 'nonstop', 'non-stop', 'stops', 'stop',
      'economy', 'business', 'premium economy', 'premium', 'first class', 'first',
      'departure', 'arrival', 'select', 'view', 'book', 'price', 'duration',
      'class', 'cabin', 'fare', 'refundable', 'non refundable',
      // Etrav round-trip leg badges (captured as bogus airlines in earlier runs)
      'onward', 'return', 'outbound', 'inbound', 'onwards', 'returns',
      'available', 'unavailable', 'sold out', 'special fare', 'lowest fare',
      'recommended', 'cheapest', 'fastest', 'flexible',
      // Null/missing field markers
      'none', 'null', 'n/a', 'na', 'unknown', '-', '--',
    ]);
    const cards = document.querySelectorAll('.accordion_container, .flight_search_result');
    if (cards.length > 0) {
      const tally = {}; // name → count
      cards.forEach(card => {
        const text = (card.innerText || '').trim();
        // Search the first few lines for an airline-shaped name, not just line 1
        // (Etrav round-trip cards prepend an "ONWARD" / "RETURN" badge on line 1)
        const lines = text.split('\n').slice(0, 4);
        let name = null;
        for (const ln of lines) {
          const candidate = (ln.split('|')[0] || '').trim();
          if (!candidate || candidate.length < 2 || candidate.length > 25) continue;
          if (DENY_LABELS.has(candidate.toLowerCase())) continue;
          // Reject single-word all-caps badges (e.g. ONWARD, RETURN, DIRECT) —
          // real airline names are mixed-case or multi-word.
          if (/^[A-Z]{3,}$/.test(candidate)) continue;
          if (/^[\d\s\-]+$/.test(candidate)) continue;
          name = candidate;
          break;
        }
        if (name) tally[name] = (tally[name] || 0) + 1;
      });
      const airlines = Object.entries(tally)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
      if (airlines.length > 0) {
        return { found: true, source: 'cards', airlines, diag, bbox: null };
      }
    }

    return { found: false, source: null, airlines: [], diag };
  });
}

/**
 * Public: capture airline filter screenshot + parse airlines.
 * @param {import('playwright').Page} page
 * @param {string} screenshotDir absolute dir where to save the PNG
 * @param {string} searchLabel e.g. "DEL-DXB"
 * @returns {Promise<{screenshotPath:string, airlines:Array<{name:string,count:number}>}|null>}
 */
/**
 * Try to find and click an "Airlines" filter trigger on Etrav's results page,
 * then wait for the expanded panel to render. Returns true if a panel opened.
 */
async function _expandAirlinesFilter(page) {
  // 2026-06-02 v2: scored candidate selection + verify-and-retry loop.
  // The previous "first match wins" approach was clicking the section header
  // (a span/label) instead of the actual dropdown trigger button, so the
  // panel never opened and we fell back to result-cards (no screenshot).
  try {
    const baselineCB = await page.evaluate(() =>
      document.querySelectorAll('input[type=checkbox]').length);

    for (let attempt = 0; attempt < 3; attempt++) {
      const clicked = await page.evaluate((skipRank) => {
        const all = Array.from(document.querySelectorAll(
          'button, [role="button"], a, label, div, span, li, h1, h2, h3, h4, h5'
        ));
        const scored = [];
        for (const el of all) {
          const txt = (el.innerText || el.textContent || '').trim();
          if (txt.length === 0 || txt.length > 30) continue;
          if (!/airlines?/i.test(txt)) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          let score = 0;
          if (/^airlines?$/i.test(txt)) score += 10;
          else if (/^airlines?\s*\(\d+\)$/i.test(txt)) score += 9;
          else if (/^.{0,4}airlines?\b/i.test(txt)) score += 5;
          const tag = el.tagName.toLowerCase();
          if (tag === 'button' || el.getAttribute('role') === 'button') score += 6;
          const cls = String(el.className || '').toLowerCase();
          if (/filter|dropdown|trigger|toggle|popover|menu/.test(cls)) score += 4;
          if (/header|title|heading/.test(cls)) score -= 3;
          if (/^h[1-6]$/.test(tag)) score -= 3;
          try { if (getComputedStyle(el).cursor === 'pointer') score += 2; } catch {}
          // Don't double-mark elements we've already tried
          if (el.hasAttribute('data-eqis-airline-tried')) score -= 100;
          scored.push({ el, score, txt });
        }
        scored.sort((a, b) => b.score - a.score);
        const pick = scored[skipRank];
        if (!pick || pick.score < 0) return null;
        try {
          pick.el.setAttribute('data-eqis-airline-tried', '1');
          pick.el.setAttribute('data-eqis-airline-trigger', '1');
          pick.el.scrollIntoView({ block: 'center' });
          pick.el.click();
          return { txt: pick.txt, score: pick.score };
        } catch { return null; }
      }, 0); // always pick highest-scoring remaining candidate

      if (!clicked) break;
      await page.waitForTimeout(900);

      // Verify dropdown actually opened: checkbox count went up OR Select All appeared
      const verified = await page.evaluate(() => {
        const cbCount = document.querySelectorAll('input[type=checkbox]').length;
        const hasSelectAll = Array.from(document.querySelectorAll('*'))
          .some(e => /^select all$/i.test((e.textContent || '').trim()) && e.children.length <= 1);
        return { cbCount, hasSelectAll };
      });
      if (verified.cbCount > baselineCB + 2 || verified.hasSelectAll) return true;

      // Strip the wrong trigger so Strategy retry won't screenshot it
      await page.evaluate(() => {
        const wrong = document.querySelector('[data-eqis-airline-trigger="1"]');
        if (wrong) wrong.removeAttribute('data-eqis-airline-trigger');
      });
    }
    // Even if we couldn't verify expansion, parser can still find a visible
    // sidebar panel via Strategy 0/1. Return true so caller continues.
    return true;
  } catch { return false; }
}

async function captureAirlineFilter(page, screenshotDir, searchLabel) {
  try {
    // FIRST: try to click the Airlines filter dropdown to expand it
    let expanded = false;
    try { expanded = await _expandAirlinesFilter(page); } catch {}
    const parsed = await _markAndParseAirlineFilter(page);
    const diagStr = parsed && parsed.diag
      ? ' diag=' + JSON.stringify(parsed.diag) + ' expanded=' + expanded
      : ' expanded=' + expanded;
    if (!parsed || !parsed.found) {
      logger.info('[AIRLINE-FILTER] No filter & no cards on page — skipping capture' + diagStr);
      return null;
    }
    if (!parsed.airlines || parsed.airlines.length === 0) {
      logger.info('[AIRLINE-FILTER] Found ' + parsed.source + ' but 0 rows parsed — skipping' + diagStr);
      return null;
    }
    try { fs.mkdirSync(screenshotDir, { recursive: true }); } catch {}
    const fname = 'airline-filter-' + slugify(searchLabel) + '.png';
    const shotPath = path.join(screenshotDir, fname);
    let screenshotPath = null;
    // 2026-06-02: ONLY screenshot when we found the real dropdown panel via
    // the "Select All" strategy (parsed.source === 'filter'). The earlier
    // trigger-area + viewport fallbacks were producing 590x32 sliver shots
    // of Etrav's top filter BUTTON BAR — useless and misleading. If we only
    // have the result-cards fallback ('cards'), the airline names are still
    // accurate but we deliberately skip screenshot rather than ship the wrong
    // image. The dashboard already handles missing screenshotPath gracefully.
    if (parsed.source === 'filter') {
      const filterHandle = await page.$('[data-eqis-airline-filter="1"]');
      if (filterHandle) {
        try { await filterHandle.scrollIntoViewIfNeeded({ timeout: 2000 }); } catch {}
        try {
          await filterHandle.screenshot({ path: shotPath });
          screenshotPath = shotPath;
        } catch (shotErr) {
          logger.warn('[AIRLINE-FILTER] Filter element screenshot failed: ' + shotErr.message);
        }
      }
    }
    logger.info('[AIRLINE-FILTER] Captured ' + parsed.airlines.length + ' airlines via ' + parsed.source +
      ' for ' + searchLabel + (screenshotPath ? ' → ' + fname : ' (no screenshot)') + diagStr);
    return {
      screenshotPath: screenshotPath,
      airlines: parsed.airlines,
      source: parsed.source,
    };
  } catch (err) {
    logger.warn('[AIRLINE-FILTER] Capture failed: ' + err.message);
    return null;
  }
}

module.exports = { captureAirlineFilter };
