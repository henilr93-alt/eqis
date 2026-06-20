const logger = require('../utils/logger');
const { clickElement, waitForSelector } = require('../utils/etravFormHelpers');

/**
 * Enhanced hotel date picker with improved reliability
 * Fixes SPF failures from date field population issues
 */
async function pickHotelDateRange(page, checkinDate, checkoutDate) {
  try {
    logger.info('[HOTEL-DATES] Starting enhanced date picker flow');
    
    // Wait for form to be fully interactive
    await page.waitForTimeout(2000);
    
    // Primary attempt - existing flow with enhanced waits
    const success = await attemptDateSelection(page, checkinDate, checkoutDate, 'primary');
    if (success) {
      logger.info('[HOTEL-DATES] Primary date selection succeeded');
      return true;
    }
    
    // Fallback 1 - Retry with longer waits
    logger.warn('[HOTEL-DATES] Primary failed, trying fallback with longer waits');
    await page.waitForTimeout(1000);
    const fallback1 = await attemptDateSelection(page, checkinDate, checkoutDate, 'fallback1', true);
    if (fallback1) {
      logger.info('[HOTEL-DATES] Fallback 1 date selection succeeded');
      return true;
    }
    
    // Fallback 2 - Direct input value setting
    logger.warn('[HOTEL-DATES] Fallback 1 failed, trying direct input approach');
    const fallback2 = await attemptDirectInputs(page, checkinDate, checkoutDate);
    if (fallback2) {
      logger.info('[HOTEL-DATES] Direct input fallback succeeded');
      return true;
    }
    
    logger.error('[HOTEL-DATES] All date selection attempts failed');
    return false;
    
  } catch (error) {
    logger.error('[HOTEL-DATES] Error in pickHotelDateRange:', error.message);
    return false;
  }
}

/**
 * Attempt date selection with improved element detection
 */
async function attemptDateSelection(page, checkinDate, checkoutDate, attempt, longWaits = false) {
  try {
    const waitTime = longWaits ? 3000 : 1500;
    
    // Enhanced check-in date selection
    const checkinSuccess = await selectDateField(page, 'checkin', checkinDate, waitTime);
    if (!checkinSuccess) {
      logger.warn(`[HOTEL-DATES] ${attempt}: Check-in date selection failed`);
      return false;
    }
    
    await page.waitForTimeout(500);
    
    // Enhanced check-out date selection
    const checkoutSuccess = await selectDateField(page, 'checkout', checkoutDate, waitTime);
    if (!checkoutSuccess) {
      logger.warn(`[HOTEL-DATES] ${attempt}: Check-out date selection failed`);
      return false;
    }
    
    // Verify both dates are populated
    const verification = await verifyDatesPopulated(page, checkinDate, checkoutDate);
    if (!verification) {
      logger.warn(`[HOTEL-DATES] ${attempt}: Date verification failed`);
      return false;
    }
    
    return true;
    
  } catch (error) {
    logger.error(`[HOTEL-DATES] ${attempt} attempt error:`, error.message);
    return false;
  }
}

/**
 * Select individual date field with multiple selector strategies
 */
async function selectDateField(page, fieldType, dateValue, waitTime) {
  const selectors = fieldType === 'checkin' ? [
    'input[data-testid="checkin-date"]',
    'input[placeholder*="Check-in"]',
    'input[name*="checkin"]',
    '.hotel-search input:first-of-type',
    '#checkin-date'
  ] : [
    'input[data-testid="checkout-date"]',
    'input[placeholder*="Check-out"]',
    'input[name*="checkout"]',
    '.hotel-search input:nth-of-type(2)',
    '#checkout-date'
  ];
  
  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (!element) continue;
      
      // Check if element is visible and interactable
      const isVisible = await element.isVisible();
      if (!isVisible) continue;
      
      logger.info(`[HOTEL-DATES] Attempting ${fieldType} with selector: ${selector}`);
      
      // Click and wait for calendar
      await element.click();
      await page.waitForTimeout(waitTime);
      
      // Look for active calendar or date picker
      const calendarVisible = await page.$('.react-datepicker, .date-picker, [role="dialog"]');
      
      if (calendarVisible) {
        // Calendar approach - click specific date
        const dateClicked = await clickCalendarDate(page, dateValue);
        if (dateClicked) {
          logger.info(`[HOTEL-DATES] Calendar date clicked for ${fieldType}`);
          return true;
        }
      }
      
      // Direct input approach
      await element.click({ clickCount: 3 }); // Select all
      await element.type(dateValue);
      await page.keyboard.press('Tab'); // Commit the input
      
      // Quick verification
      const value = await element.inputValue();
      if (value && value.includes(dateValue.split('-')[2])) { // Check day is present
        logger.info(`[HOTEL-DATES] Direct input successful for ${fieldType}`);
        return true;
      }
      
    } catch (error) {
      logger.warn(`[HOTEL-DATES] Selector ${selector} failed:`, error.message);
      continue;
    }
  }
  
  return false;
}

/**
 * Click specific date in calendar popup
 */
async function clickCalendarDate(page, dateValue) {
  try {
    const [year, month, day] = dateValue.split('-');
    const dayNum = parseInt(day, 10);
    
    // Wait for calendar to be fully loaded
    await page.waitForTimeout(1000);
    
    // Try multiple calendar date selectors
    const dateSelectors = [
      `[aria-label*="${dayNum}"]`,
      `button:has-text("${dayNum}")`,
      `.react-datepicker__day--${dayNum.toString().padStart(3, '0')}`,
      `[data-day="${dayNum}"]`,
      `td:has-text("${dayNum}")`
    ];
    
    for (const selector of dateSelectors) {
      try {
        const dateEl = await page.$(selector);
        if (dateEl && await dateEl.isVisible()) {
          await dateEl.click();
          await page.waitForTimeout(300);
          return true;
        }
      } catch (e) {
        continue;
      }
    }
    
    return false;
  } catch (error) {
    logger.warn('[HOTEL-DATES] Calendar date click failed:', error.message);
    return false;
  }
}

/**
 * Fallback: Direct input value setting bypassing UI
 */
async function attemptDirectInputs(page, checkinDate, checkoutDate) {
  try {
    logger.info('[HOTEL-DATES] Attempting direct input value setting');
    
    // Format dates for display (assuming DD/MM/YYYY or similar)
    const formatDate = (dateStr) => {
      const [year, month, day] = dateStr.split('-');
      return `${day}/${month}/${year}`;
    };
    
    const checkinFormatted = formatDate(checkinDate);
    const checkoutFormatted = formatDate(checkoutDate);
    
    // Direct value setting via page.evaluate
    const success = await page.evaluate(({ checkin, checkout }) => {
      // Find check-in input
      const checkinInputs = [
        document.querySelector('input[data-testid="checkin-date"]'),
        document.querySelector('input[placeholder*="Check-in"]'),
        document.querySelector('input[name*="checkin"]'),
        document.querySelector('.hotel-search input:first-of-type')
      ].filter(Boolean);
      
      // Find check-out input
      const checkoutInputs = [
        document.querySelector('input[data-testid="checkout-date"]'),
        document.querySelector('input[placeholder*="Check-out"]'),
        document.querySelector('input[name*="checkout"]'),
        document.querySelector('.hotel-search input:nth-of-type(2)')
      ].filter(Boolean);
      
      let success = 0;
      
      // Set check-in value
      if (checkinInputs[0]) {
        const input = checkinInputs[0];
        if (input._valueTracker) {
          input._valueTracker.setValue(checkin);
        }
        input.value = checkin;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        success++;
      }
      
      // Set check-out value
      if (checkoutInputs[0]) {
        const input = checkoutInputs[0];
        if (input._valueTracker) {
          input._valueTracker.setValue(checkout);
        }
        input.value = checkout;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        success++;
      }
      
      return success === 2;
    }, { checkin: checkinFormatted, checkout: checkoutFormatted });
    
    if (success) {
      await page.waitForTimeout(1000);
      // Verify the values stuck
      const finalCheck = await verifyDatesPopulated(page, checkinDate, checkoutDate);
      return finalCheck;
    }
    
    return false;
    
  } catch (error) {
    logger.error('[HOTEL-DATES] Direct input fallback error:', error.message);
    return false;
  }
}

/**
 * Verify dates are properly populated in the form
 */
async function verifyDatesPopulated(page, expectedCheckin, expectedCheckout) {
  try {
    const verification = await page.evaluate(() => {
      const checkinInputs = [
        document.querySelector('input[data-testid="checkin-date"]'),
        document.querySelector('input[placeholder*="Check-in"]'),
        document.querySelector('input[name*="checkin"]'),
        document.querySelector('.hotel-search input:first-of-type')
      ].filter(Boolean);
      
      const checkoutInputs = [
        document.querySelector('input[data-testid="checkout-date"]'),
        document.querySelector('input[placeholder*="Check-out"]'),
        document.querySelector('input[name*="checkout"]'),
        document.querySelector('.hotel-search input:nth-of-type(2)')
      ].filter(Boolean);
      
      const checkinValue = checkinInputs[0]?.value || '';
      const checkoutValue = checkoutInputs[0]?.value || '';
      
      return {
        checkinValue,
        checkoutValue,
        hasCheckin: checkinValue.length > 0,
        hasCheckout: checkoutValue.length > 0
      };
    });
    
    const success = verification.hasCheckin && verification.hasCheckout;
    
    if (success) {
      logger.info(`[HOTEL-DATES] Date verification passed: checkin=${verification.checkinValue}, checkout=${verification.checkoutValue}`);
    } else {
      logger.warn(`[HOTEL-DATES] Date verification failed: checkin=${verification.checkinValue}, checkout=${verification.checkoutValue}`);
    }
    
    return success;
    
  } catch (error) {
    logger.error('[HOTEL-DATES] Date verification error:', error.message);
    return false;
  }
}

module.exports = {
  pickHotelDateRange
};