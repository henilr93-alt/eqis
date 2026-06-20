const logger = require('./logger');

/**
 * Passenger form helpers for accurate pax count submission
 * Handles adult/child/infant breakdown correctly
 */

/**
 * Fill passenger count form with accurate breakdown
 * @param {Object} page - Playwright page
 * @param {Object} passengers - {adults: number, children: number, infants: number}
 * @param {string} context - Search context for logging
 * @returns {Promise<boolean>} Success status
 */
async function fillPassengerForm(page, passengers, context = 'unknown') {
  try {
    const { adults = 1, children = 0, infants = 0 } = passengers;
    const totalPax = adults + children + infants;
    
    logger.log(`[PassengerForm] ${context} - Filling ${adults}A+${children}C+${infants}I (${totalPax} total)`);
    
    // Wait for passenger dropdown or form
    const passengerSelector = 'div[data-testid="passenger-selector"], .passenger-dropdown, .pax-selector';
    await page.waitForSelector(passengerSelector, { timeout: 5000 });
    
    // Click to open passenger selector
    await page.click(passengerSelector);
    await page.waitForTimeout(500);
    
    // Fill adults count
    const adultInput = 'input[data-testid="adults"], input[name="adults"], .adult-count input';
    await page.waitForSelector(adultInput, { timeout: 3000 });
    await page.fill(adultInput, adults.toString());
    
    // Fill children count if > 0
    if (children > 0) {
      const childInput = 'input[data-testid="children"], input[name="children"], .child-count input';
      await page.waitForSelector(childInput, { timeout: 3000 });
      await page.fill(childInput, children.toString());
    }
    
    // Fill infants count if > 0
    if (infants > 0) {
      const infantInput = 'input[data-testid="infants"], input[name="infants"], .infant-count input';
      await page.waitForSelector(infantInput, { timeout: 3000 });
      await page.fill(infantInput, infants.toString());
    }
    
    // Validate the form shows correct breakdown before proceeding
    await page.waitForTimeout(300);
    const isValid = await validatePassengerCounts(page, { adults, children, infants });
    
    if (!isValid) {
      logger.log(`[PassengerForm] ${context} - Validation failed, retrying with programmatic input`);
      return await fillPassengerFormProgrammatic(page, { adults, children, infants }, context);
    }
    
    // Close passenger selector
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    
    logger.log(`[PassengerForm] ${context} - Successfully filled ${adults}A+${children}C+${infants}I`);
    return true;
    
  } catch (error) {
    logger.log(`[PassengerForm] ${context} - Fill failed: ${error.message}`);
    return false;
  }
}

/**
 * Programmatic fallback for passenger form filling
 * @param {Object} page - Playwright page
 * @param {Object} passengers - {adults: number, children: number, infants: number}
 * @param {string} context - Search context
 * @returns {Promise<boolean>} Success status
 */
async function fillPassengerFormProgrammatic(page, passengers, context) {
  try {
    const { adults, children, infants } = passengers;
    
    // Direct value setting via _valueTracker (bypasses UI quirks)
    await page.evaluate(({ adults, children, infants }) => {
      const adultInput = document.querySelector('input[data-testid="adults"], input[name="adults"], .adult-count input');
      const childInput = document.querySelector('input[data-testid="children"], input[name="children"], .child-count input');
      const infantInput = document.querySelector('input[data-testid="infants"], input[name="infants"], .infant-count input');
      
      if (adultInput && adultInput._valueTracker) {
        adultInput._valueTracker.setValue(adults.toString());
        adultInput.value = adults.toString();
        adultInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
      if (childInput && children > 0 && childInput._valueTracker) {
        childInput._valueTracker.setValue(children.toString());
        childInput.value = children.toString();
        childInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      
      if (infantInput && infants > 0 && infantInput._valueTracker) {
        infantInput._valueTracker.setValue(infants.toString());
        infantInput.value = infants.toString();
        infantInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, { adults, children, infants });
    
    await page.waitForTimeout(500);
    logger.log(`[PassengerForm] ${context} - Programmatic fill completed`);
    return true;
    
  } catch (error) {
    logger.log(`[PassengerForm] ${context} - Programmatic fill failed: ${error.message}`);
    return false;
  }
}

/**
 * Validate passenger counts match expected values
 * @param {Object} page - Playwright page
 * @param {Object} expected - {adults: number, children: number, infants: number}
 * @returns {Promise<boolean>} Validation result
 */
async function validatePassengerCounts(page, expected) {
  try {
    const actual = await page.evaluate(() => {
      const adultInput = document.querySelector('input[data-testid="adults"], input[name="adults"], .adult-count input');
      const childInput = document.querySelector('input[data-testid="children"], input[name="children"], .child-count input');
      const infantInput = document.querySelector('input[data-testid="infants"], input[name="infants"], .infant-count input');
      
      return {
        adults: adultInput ? parseInt(adultInput.value) || 0 : 0,
        children: childInput ? parseInt(childInput.value) || 0 : 0,
        infants: infantInput ? parseInt(infantInput.value) || 0 : 0
      };
    });
    
    const matches = actual.adults === expected.adults && 
                   actual.children === expected.children && 
                   actual.infants === expected.infants;
    
    if (!matches) {
      logger.log(`[PassengerForm] Validation mismatch - Expected: ${expected.adults}A+${expected.children}C+${expected.infants}I, Got: ${actual.adults}A+${actual.children}C+${actual.infants}I`);
    }
    
    return matches;
  } catch (error) {
    logger.log(`[PassengerForm] Validation error: ${error.message}`);
    return false;
  }
}

/**
 * Extract passenger breakdown from search context string
 * @param {string} searchContext - Context like "4A 3C 1I"
 * @returns {Object} {adults: number, children: number, infants: number}
 */
function parsePassengerContext(searchContext) {
  try {
    // Extract passenger counts from context like "4A 3C 1I" or "8 pax"
    const adultMatch = searchContext.match(/(\d+)A/);
    const childMatch = searchContext.match(/(\d+)C/);
    const infantMatch = searchContext.match(/(\d+)I/);
    
    const adults = adultMatch ? parseInt(adultMatch[1]) : 1;
    const children = childMatch ? parseInt(childMatch[1]) : 0;
    const infants = infantMatch ? parseInt(infantMatch[1]) : 0;
    
    // Fallback for "8 pax" format - assume all adults if no breakdown
    if (!adultMatch && !childMatch && !infantMatch) {
      const totalMatch = searchContext.match(/(\d+)\s*pax/);
      if (totalMatch) {
        return { adults: parseInt(totalMatch[1]), children: 0, infants: 0 };
      }
    }
    
    return { adults, children, infants };
  } catch (error) {
    logger.log(`[PassengerForm] Parse error for context "${searchContext}": ${error.message}`);
    return { adults: 1, children: 0, infants: 0 };
  }
}

/**
 * Verify URL contains correct passenger parameters after search submission
 * @param {Object} page - Playwright page
 * @param {Object} expected - {adults: number, children: number, infants: number}
 * @param {string} context - Search context
 * @returns {Promise<boolean>} URL validation result
 */
async function validateUrlPassengerParams(page, expected, context) {
  try {
    await page.waitForTimeout(1000); // Let URL settle
    const currentUrl = page.url();
    
    // Extract passenger params from URL
    const url = new URL(currentUrl);
    const urlAdults = parseInt(url.searchParams.get('adults')) || 0;
    const urlChildren = parseInt(url.searchParams.get('children')) || 0;
    const urlInfants = parseInt(url.searchParams.get('infants')) || 0;
    
    const urlMatches = urlAdults === expected.adults && 
                      urlChildren === expected.children && 
                      urlInfants === expected.infants;
    
    if (!urlMatches) {
      logger.log(`[PassengerForm] ${context} - URL param mismatch - Expected: ${expected.adults}A+${expected.children}C+${expected.infants}I, URL shows: ${urlAdults}A+${urlChildren}C+${urlInfants}I`);
      logger.log(`[PassengerForm] ${context} - Problem URL: ${currentUrl}`);
    } else {
      logger.log(`[PassengerForm] ${context} - URL params correct: ${urlAdults}A+${urlChildren}C+${urlInfants}I`);
    }
    
    return urlMatches;
  } catch (error) {
    logger.log(`[PassengerForm] ${context} - URL validation error: ${error.message}`);
    return false;
  }
}

module.exports = {
  fillPassengerForm,
  fillPassengerFormProgrammatic,
  validatePassengerCounts,
  parsePassengerContext,
  validateUrlPassengerParams
};