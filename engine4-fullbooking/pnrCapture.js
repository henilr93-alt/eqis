const logger = require('../utils/logger');

async function capture(page, type) {
  const result = { pnr: null, bookingRef: null, screenshot: null };

  try {
    const pnrSelectors = [
      '[class*="pnr"]', '[class*="booking-ref"]',
      '[class*="confirmation-number"]', '[data-field="pnr"]',
    ];

    for (const sel of pnrSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          const text = await el.textContent();
          const pnrMatch = text?.match(/[A-Z]{6}|[A-Z0-9]{6,8}/);
          if (pnrMatch) {
            result.pnr = pnrMatch[0];
            break;
          }
        }
      } catch { /* continue */ }
    }

    // Try to find PNR in page text as fallback
    if (!result.pnr) {
      const bodyText = await page.textContent('body');
      const pnrMatch = bodyText.match(/PNR[:\s]*([A-Z]{6})/i) ||
        bodyText.match(/Booking\s*(?:ID|Ref|Reference)[:\s]*([A-Z0-9]{6,10})/i);
      if (pnrMatch) result.pnr = pnrMatch[1];
    }

    // Booking ref (may be different from PNR)
    const refEl = await page.$('[class*="booking-id"], [class*="order-id"]');
    if (refEl) result.bookingRef = (await refEl.textContent())?.trim();

    // Screenshot
    const buffer = await page.screenshot({ fullPage: true });
    result.screenshot = buffer.toString('base64');

    if (result.pnr) {
      logger.info(`[PNR] Captured ${type} PNR: ${result.pnr}`);
    } else {
      logger.warn(`[PNR] Could not extract PNR from ${type} confirmation page`);
    }
  } catch (err) {
    logger.error(`[PNR] Capture failed: ${err.message}`);
  }

  return result;
}

module.exports = { capture };
