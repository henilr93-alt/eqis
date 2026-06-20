// reviewPageExtractor.js — Scrape the Etrav /flights/itinerary-page after
// clicking Book on a fare. Captures load metrics + meaningful errors.
//
// Tightened from the first recon: we explicitly exclude fare-policy labels
// like "Non Refundable" / "Refundable" which match a broad
// [class*="error"] regex but are not actual errors.

const POLICY_LABEL_RX = /^(non[\s\-]?refundable|refundable|partially\s*refundable|special\s*conditions?)$/i;

async function extract(page, bookClickStart) {
  const loadMs = Date.now() - bookClickStart;
  const dom = await page.evaluate(({ excludeRxSrc }) => {
    const excludeRx = new RegExp(excludeRxSrc, 'i');
    // Banner-like elements with substantive text
    const seenBanners = new Set();
    const banners = [];
    document.querySelectorAll(
      '[class*="error" i], [class*="alert" i], [class*="banner" i], [role="alert"]'
    ).forEach(el => {
      const t = (el.textContent || '').trim();
      if (!t || t.length < 4 || t.length > 250) return;
      if (excludeRx.test(t)) return;
      if (seenBanners.has(t)) return;
      seenBanners.add(t);
      banners.push(t.slice(0, 180));
    });
    // Captured prices visible on the page
    const fareCandidates = [];
    document.querySelectorAll('div, span, td').forEach(el => {
      if (el.children.length > 0) return;
      const t = (el.textContent || '').trim();
      if (/^\u20b9[\d,]+(?:\.\d+)?$/.test(t)) fareCandidates.push(t);
    });
    // Capture the airline name and flight code shown on the review/itinerary
    // page so the engine can verify it matches the picked target.
    const bodyText = (document.body && document.body.innerText || '');
    const flightCodeMatch = bodyText.match(/\b([A-Z0-9]{2})\s?\d{1,4}\b/);
    // Collect EVERY 2-char-airline + 1-4-digit code on the page so the matcher
    // can cope with multi-stop / codeshare itineraries where the first regex
    // hit can be a class code (e.g. "Y3") instead of the booked flight code.
    const allFlightCodes = [];
    const seenCodes = new Set();
    const codeRx = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/g;
    let mm;
    while ((mm = codeRx.exec(bodyText)) !== null) {
      const code = (mm[1] + mm[2]).toUpperCase();
      if (!seenCodes.has(code)) { seenCodes.add(code); allFlightCodes.push(code); }
      if (allFlightCodes.length >= 30) break;
    }
    return {
      url:               window.location.href,
      title:             document.title,
      bodyTextLen:       bodyText.length,
      reviewBodySample:  bodyText.replace(/\s+/g, ' ').trim().slice(0, 400),
      reviewBodyFull:    bodyText.replace(/\s+/g, ' ').trim().slice(0, 4000),
      reviewFlightCode:  flightCodeMatch ? (flightCodeMatch[1] + (flightCodeMatch[0].match(/\d+$/) || [''])[0]).trim() : null,
      allFlightCodes:    allFlightCodes,
      hasPassengerForm:  !!document.querySelector('input[name*="first" i], input[name*="passenger" i]'),
      hasPriceSummary:   !!document.querySelector('[class*="totalPrice" i], [class*="grandTotal" i], [class*="fareSummary" i]'),
      hasContinueButton: !!Array.from(document.querySelectorAll('button')).find(b => {
        const t = (b.textContent || '').trim();
        return /^(book\s*now|continue|confirm|pay\s*now|proceed)$/i.test(t);
      }),
      errorBanners:      banners.slice(0, 8),
      fareCandidates:    fareCandidates.slice(0, 8),
    };
  }, { excludeRxSrc: POLICY_LABEL_RX.source }).catch(() => null);
  return { loadMs, ...(dom || {}) };
}

module.exports = { extract };
