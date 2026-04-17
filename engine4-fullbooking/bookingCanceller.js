const logger = require('../utils/logger');

async function cancel(page, pnr, bookingRef, type) {
  const result = { status: 'NOT_ATTEMPTED', screenshot: null, error: null };

  if (!pnr && !bookingRef) {
    result.status = 'SKIPPED_NO_PNR';
    result.error = 'No PNR or booking ref — nothing to cancel';
    return result;
  }

  logger.info(`[CANCEL] Attempting to cancel ${type} PNR: ${pnr || bookingRef}`);

  try {
    // Navigate to My Bookings
    const navSelectors = [
      'a[href*="bookings"]', 'a[href*="my-trips"]',
      'a:has-text("My Bookings")', 'a:has-text("My Trips")',
      '[class*="my-bookings"]',
    ];

    let navigated = false;
    for (const sel of navSelectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); navigated = true; break; }
    }

    if (!navigated) {
      result.status = 'NAV_FAILED';
      result.error = 'Could not navigate to My Bookings page';
      return result;
    }

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Find most recent booking
    const bookingRows = await page.$$('[class*="booking-row"], [class*="booking-card"], [class*="trip-card"]');
    if (bookingRows.length === 0) {
      result.status = 'BOOKING_NOT_FOUND_IN_LIST';
      result.error = 'No bookings found in My Bookings list';
      return result;
    }

    // Click cancel on first (most recent) booking
    const cancelBtn = await bookingRows[0].$('button:has-text("Cancel"), [data-action="cancel"], a:has-text("Cancel")');
    if (!cancelBtn) {
      result.status = 'CANCEL_BUTTON_NOT_FOUND';
      result.error = 'Cancel button not found on booking row';
      const buffer = await page.screenshot({ fullPage: true });
      result.screenshot = buffer.toString('base64');
      return result;
    }

    await cancelBtn.click();
    await page.waitForTimeout(1000);

    // Confirm cancellation dialog
    const confirmSelectors = [
      'button:has-text("Confirm")', 'button:has-text("Yes")',
      'button:has-text("Yes, Cancel")', 'button:has-text("Proceed")',
    ];
    for (const sel of confirmSelectors) {
      const el = await page.$(sel);
      if (el) { await el.click(); break; }
    }

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Verify cancellation
    const cancelledIndicators = [
      '[class*="cancelled"]', 'text=Cancelled',
      'text=Cancellation Successful', 'text=Successfully Cancelled',
    ];
    let confirmed = false;
    for (const sel of cancelledIndicators) {
      const el = await page.$(sel);
      if (el) { confirmed = true; break; }
    }

    result.status = confirmed ? 'CANCELLED' : 'CANCEL_STATUS_UNKNOWN';
    const buffer = await page.screenshot({ fullPage: true });
    result.screenshot = buffer.toString('base64');

    logger.info(`[CANCEL] ${type} cancellation: ${result.status}`);
  } catch (err) {
    result.status = 'CANCEL_FAILED';
    result.error = err.message;
    logger.error(`[CANCEL] Failed: ${err.message}`);
  }

  return result;
}

module.exports = { cancel };
