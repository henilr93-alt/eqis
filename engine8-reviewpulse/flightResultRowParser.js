// flightResultRowParser.js — On Etrav's flight results page, enumerate every
// (airline × flight × fareOpts) combo currently visible. Used by the random
// picker to choose what to review next.

/**
 * Wait until the result set stabilises. Etrav progressively loads airlines
 * from multiple GDS sources; the row count grows for up to ~90s.
 *
 * @param {import('playwright').Page} page
 * @param {Object} opts { maxChecks, settleAfter, pollMs }
 * @returns {Promise<number>} final populated-row count
 */
async function waitForResultsFullyLoaded(page, opts) {
  const o = opts || {};
  const maxChecks      = o.maxChecks      || 60;
  const settleAfter    = o.settleAfter    || 5;
  const pollMs         = o.pollMs         || 2000;
  // 2026-06-15: early-success heuristic so slow GDS routes (CCU->BKK, multi-
  // airline INTL) do not hit the Review HARD_TIMEOUT. If we have a healthy
  // population (>= earlySuccessMin) and 2 consecutive stable samples, bail
  // out positively even before full settle. Etrav can keep trickling rows
  // for 60-120 s — we do not need every last row to make a fair pick.
  const earlySuccessMin = o.earlySuccessMin || 30;
  const earlySuccessSettle = o.earlySuccessSettle || 2;
  // 2026-06-16: high-volume cap. On dense sectors (DEL->SIN, DEL->DXB) Etrav
  // can trickle 150+ rows over 140+ seconds, eating 78% of the 180 s
  // HARD_TIMEOUT budget before any click happens. At highVolumeCap rows we
  // already have an over-abundance of choice and don't need to wait for
  // every last row. Bail immediately regardless of stability when this
  // threshold is hit, leaving plenty of budget for click + nav + capture.
  // See REV-MQGB0YQ1-D4FE (DEL->SIN, 156 rows after 140 s, HARD_TIMEOUT
  // killed the +10s retry after page DID render Malaysia Airlines).
  const highVolumeCap = o.highVolumeCap || 100;
  // 2026-06-15: deadlock guard — Playwright's page.evaluate() has no built-in
  // per-call timeout. When the Etrav page's JS event loop is frozen (loading
  // bar stuck, GDS timeout, JS error, blank page), every evaluate() awaits
  // forever and .catch() can never fire because the promise never rejects.
  // The outer 180 s HARD_TIMEOUT in reviewPulseEngine.js is then the only
  // brake. Two scoped guards stop this deadlock here:
  //   (a) every page.evaluate() is raced against a setTimeout so a frozen
  //       page resolves the wrapper to 0 instead of hanging.
  //   (b) after frozenBailAfter consecutive checks with 0 populated rows, we
  //       bail with last = 0 so the upstream emits a clean RESULTS_NOT_LOADED
  //       / FAILED_TO_LOAD verdict instead of dragging into HARD_TIMEOUT.
  // Both guards are bounded ABOVE the wait function's normal happy path so
  // healthy slow-GDS sectors are unaffected. See REV-MQET3HZY-82E1 BOM->DXB
  // (blank Etrav page, 180 s HARD_TIMEOUT, only 2 events captured).
  const evalTimeoutMs = o.evalTimeoutMs || 5000;
  // 2026-06-16: bumped 6 -> 10 to stop false-negative RESULTS_NOT_LOADED on
  // slow LKO->SHJ-style routes where Etrav's GDS takes longer to populate
  // than the 72 s bail window (e.g. REV-MQGBA8YU-9B2E: parser bailed at 0
  // populated, then ~15 flight rows appeared right after on the screenshot).
  // 10 frozen iterations × (5 s eval + 5 s scroll + 2 s pollMs) ≈ 120 s,
  // still under the 180 s HARD_TIMEOUT.
  const frozenBailAfter = o.frozenBailAfter || 10;
  const _eval = (fn) => Promise.race([
    page.evaluate(fn).catch(() => 0),
    new Promise(r => setTimeout(() => r(0), evalTimeoutMs)),
  ]);
  let last = -1, stable = 0, frozenStreak = 0;
  for (let i = 0; i < maxChecks; i++) {
    const populated = await _eval(() => {
      // 2026-06-15: tighter populated test — at least ONE visible line must
      // start with airline+flightCode in the same shape the extractor needs.
      // Prior version accepted any flight-code substring anywhere in the
      // textContent (incl. metadata/aria), which let the early-success bail
      // exit on partially-hydrated rows where the visible airline line had
      // not yet rendered → 0 parseable combos → RESULTS_NOT_LOADED (see
      // REV-MQE9ZF8S-7536 BOM->BKK, 30 rows, 0 combos).
      const lineRx = /^[A-Z][A-Za-z\s\-&\.']{1,30}?(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s*\d{1,4}/;
      // 2026-06-19: round-trip SPECIAL_RETURN cards pack the onward AND return leg
      // into one container, prefixed "ONWARD•<airline> <code>…RETURN•<airline>
      // <code>…" (e.g. "ONWARD•Nepal Airlines RA 218Class: Y16:20(DEL)…"). The
      // leading "ONWARD•" + the • bullet break the ^-anchored airline test above,
      // so these fully-rendered, fare-bearing rows counted as 0 populated → a
      // false RESULTS_NOT_LOADED even though 619 flights were on screen (see
      // FIA-MQKLCB7U-3A57 DEL->KTM). Accept a card when it carries an onward/return
      // marker immediately followed by airline+flight code AND a ₹ price — specific
      // enough to skip partially-hydrated skeleton rows (no price / no code yet).
      const srRx = /(?:ONWARD|RETURN)\s*[•·\u2022\-]?\s*[A-Za-z][A-Za-z\s\-&\.']{1,30}?(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s*\d{1,4}/;
      return Array.from(document.querySelectorAll('.accordion_container'))
        .filter(c => {
          const t = (c.textContent || '').trim();
          if (t.length <= 80) return false;
          if (srRx.test(t) && t.indexOf('\u20b9') !== -1) return true;
          const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
          return lines.some(ln => lineRx.test(ln));
        }).length;
    });
    await _eval(() => window.scrollBy(0, window.innerHeight));
    if (populated === last && populated > 0) stable++; else stable = 0;
    last = populated;
    // Frozen-page bail: count consecutive zero-populated samples; if Etrav
    // never renders any parseable row after ~24 s we abort the wait so the
    // upstream can emit a clean verdict instead of hitting HARD_TIMEOUT.
    if (populated === 0) frozenStreak++; else frozenStreak = 0;
    if (frozenStreak >= frozenBailAfter) break;
    if (stable >= settleAfter) break;
    // High-volume cap: bail immediately on dense sectors regardless of stability.
    if (populated >= highVolumeCap) break;
    // Early-success exit: enough rows + brief stability
    if (populated >= earlySuccessMin && stable >= earlySuccessSettle) break;
    await page.waitForTimeout(pollMs);
  }
  await _eval(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);
  return last < 0 ? 0 : last;
}

/**
 * Enumerate every visible (airline × flight × fareOpt) combination on the
 * results page. Each row may expose multiple fare options as parenthetical
 * tags inline, e.g. "₹20,737(NDC)₹23,098(Publish)₹23,318.98(Economy Saver)".
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Array<{rowIdx,airline,flightCode,fareIdx,fareLabel,price}>>}
 */
async function enumerateCombos(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.accordion_container'));
    const combos = [];
    for (let i = 0; i < cards.length; i++) {
      const text = (cards[i].textContent || '').trim();
      if (text.length < 80) continue;
      // 2026-06-14: scan ALL non-empty lines (not just the first) so we can
      // cope with rows where the first line is "1 Stop" / "Operated by …" /
      // a multi-stop indicator. Also accept digit-letter IATA prefixes (6E, 9W).
      const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
      const lineRx = /^([A-Z][A-Za-z\s\-&\.']{1,30}?)((?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s*\d{1,4})/;
      let m = null;
      for (const ln of lines) {
        const tryMatch = ln.match(lineRx);
        if (tryMatch) { m = tryMatch; break; }
      }
      // 2026-06-19: SPECIAL_RETURN (round-trip) fallback. These cards prefix the
      // onward leg as "ONWARD•<airline> <code>" so the ^-anchored lineRx above
      // never matches and the row would be dropped → 0 combos → false
      // RESULTS_NOT_LOADED. Pull airline + onward flight code from the ONWARD
      // marker so the row yields combos. The fare extraction + Default fallback
      // below then run unchanged on the full card text (₹…(label) pairs).
      if (!m) {
        m = text.match(/ONWARD\s*[•·\u2022\-]?\s*([A-Za-z][A-Za-z\s\-&\.']{1,30}?)((?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s*\d{1,4})/);
      }
      if (!m) continue;
      const airline    = m[1].trim();
      const flightCode = m[2].replace(/\s+/g, ' ').trim();
      const fareRx = /\u20b9([\d,]+(?:\.\d+)?)\s*\(([^)]+)\)/g;
      let fm, idx = 0;
      while ((fm = fareRx.exec(text)) !== null) {
        combos.push({
          rowIdx:     i,
          airline:    airline,
          flightCode: flightCode,
          fareIdx:    idx,
          fareLabel:  fm[2].trim(),
          price:      fm[1].replace(/,/g, ''),
        });
        idx++;
      }
      // Fallback: many routes (e.g. limited-supply carriers on DEL->KTM /
      // Nepal / smaller INTL sectors) render only a bare price with no
      // parenthetical fare label. Without this fallback the row contributes
      // zero combos and the row is silently dropped — leading to a misleading
      // RESULTS_NOT_LOADED verdict. Emit ONE combo with the cheapest visible
      // bare price and a synthetic 'Default' fare label.
      if (idx === 0) {
        const bareRx = /\u20b9\s*([\d,]+(?:\.\d+)?)/g;
        const prices = [];
        let bm;
        while ((bm = bareRx.exec(text)) !== null) {
          const n = parseFloat(bm[1].replace(/,/g, ''));
          if (!isNaN(n) && n > 100) prices.push(n);
        }
        if (prices.length > 0) {
          prices.sort((a, b) => a - b);
          combos.push({
            rowIdx:     i,
            airline:    airline,
            flightCode: flightCode,
            fareIdx:    0,
            fareLabel:  'Default',
            price:      String(prices[0]),
          });
        }
      }
    }
    return combos;
  });
}

module.exports = { waitForResultsFullyLoaded, enumerateCombos };
