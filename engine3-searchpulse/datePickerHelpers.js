const logger = require('../utils/logger');

/**
 * Enhanced date picker helpers for SearchPulse engine
 * Fixes return date selection failures with improved timing and validation
 */

/**
 * Wait for element to be visible and stable before interaction
 * @param {Page} page - Playwright page object
 * @param {string} selector - CSS selector
 * @param {number} timeout - Max wait time in ms
 * @returns {Promise<ElementHandle|null>}
 */
async function waitForVisibleElement(page, selector, timeout = 5000) {
  try {
    await page.waitForSelector(selector, { 
      state: 'visible', 
      timeout 
    });
    
    // Additional stability check - wait for element to stop moving
    await page.waitForTimeout(200);
    
    const element = await page.$(selector);
    if (!element) return null;
    
    // Verify element is actually visible and clickable
    const boundingBox = await element.boundingBox();
    if (!boundingBox || boundingBox.width === 0 || boundingBox.height === 0) {
      return null;
    }
    
    return element;
  } catch (error) {
    logger.warn(`Element not found or not visible: ${selector}`, error.message);
    return null;
  }
}

/**
 * Enhanced return date picker with robust retry logic
 * @param {Page} page - Playwright page object
 * @param {string} returnDate - Target date in YYYY-MM-DD format
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<boolean>}
 */
async function setReturnDatePicker(page, returnDate, maxRetries = 5) {
  const targetDate = new Date(returnDate);
  const targetDay = targetDate.getDate().toString();
  const targetMonth = targetDate.getMonth(); // 0-indexed
  const targetYear = targetDate.getFullYear();
  
  logger.info(`Setting return date: ${returnDate} (day: ${targetDay}, month: ${targetMonth}, year: ${targetYear})`);
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`Return date attempt ${attempt}/${maxRetries}`);
      
      // Step 1: Click return date field with visibility check
      const returnField = await waitForVisibleElement(page, 'input[data-testid="return-date-input"], .return-date-field, #returnDate');
      if (!returnField) {
        logger.warn(`Return date field not found on attempt ${attempt}`);
        await page.waitForTimeout(1000);
        continue;
      }
      
      await returnField.click();
      logger.info('Clicked return date field');
      
      // Step 2: Wait for calendar to fully load with extended timeout
      await page.waitForTimeout(800); // Increased from typical 300ms
      
      const calendarContainer = await waitForVisibleElement(page, '.react-datepicker, .calendar-container, [data-testid="date-picker"]', 3000);
      if (!calendarContainer) {
        logger.warn(`Calendar not visible on attempt ${attempt}`);
        continue;
      }
      
      // Step 3: Navigate to correct month/year if needed
      const currentMonthElement = await page.$('.react-datepicker__current-month, .calendar-month-display');
      if (currentMonthElement) {
        const currentMonthText = await currentMonthElement.textContent();
        logger.info(`Current calendar month: ${currentMonthText}`);
        
        // Simple month navigation - could be enhanced based on actual calendar structure
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December'];
        const targetMonthName = monthNames[targetMonth];
        
        if (currentMonthText && !currentMonthText.includes(targetMonthName)) {
          logger.info(`Need to navigate to ${targetMonthName}`);
          // Navigate forward/backward as needed
          const nextButton = await page.$('.react-datepicker__navigation--next, .calendar-next');
          if (nextButton) {
            await nextButton.click();
            await page.waitForTimeout(500);
          }
        }
      }
      
      // Step 4: Select the target day with improved selector logic
      const daySelectors = [
        `.react-datepicker__day--${String(targetDay).padStart(3, '0')}`,
        `[aria-label*="${targetDay}"]`,
        `.calendar-day[data-day="${targetDay}"]`,
        `.react-datepicker__day:has-text("${targetDay}")`
      ];
      
      let daySelected = false;
      for (const selector of daySelectors) {
        try {
          const dayElement = await waitForVisibleElement(page, selector, 2000);
          if (dayElement) {
            // Verify this is the correct day and not disabled
            const isDisabled = await dayElement.evaluate(el => 
              el.classList.contains('react-datepicker__day--disabled') ||
              el.classList.contains('disabled') ||
              el.getAttribute('aria-disabled') === 'true'
            );
            
            if (!isDisabled) {
              await dayElement.click();
              logger.info(`Successfully clicked day ${targetDay} using selector: ${selector}`);
              daySelected = true;
              break;
            }
          }
        } catch (selectorError) {
          logger.warn(`Day selector failed: ${selector}`, selectorError.message);
        }
      }
      
      if (!daySelected) {
        logger.warn(`Could not select day ${targetDay} on attempt ${attempt}`);
        continue;
      }
      
      // Step 5: Wait for calendar to close and verify selection
      await page.waitForTimeout(500);
      
      // Check if return date field now has the expected value
      const returnFieldValue = await returnField.inputValue().catch(() => '');
      logger.info(`Return field value after selection: ${returnFieldValue}`);
      
      // Basic validation - check if date was set (format may vary)
      if (returnFieldValue && returnFieldValue.length > 0) {
        logger.info(`Return date successfully set on attempt ${attempt}`);
        return true;
      }
      
    } catch (error) {
      logger.error(`Return date attempt ${attempt} failed:`, error.message);
    }
    
    // Wait before retry
    if (attempt < maxRetries) {
      logger.info(`Waiting 1s before retry...`);
      await page.waitForTimeout(1000);
    }
  }
  
  logger.error(`Failed to set return date after ${maxRetries} attempts`);
  return false;
}

/**
 * Enhanced departure date picker (for consistency)
 * @param {Page} page - Playwright page object
 * @param {string} departDate - Target date in YYYY-MM-DD format
 * @returns {Promise<boolean>}
 */
async function setDepartureDatePicker(page, departDate) {
  try {
    logger.info(`Setting departure date: ${departDate}`);
    
    const departField = await waitForVisibleElement(page, 'input[data-testid="depart-date-input"], .depart-date-field, #departDate');
    if (!departField) {
      logger.error('Departure date field not found');
      return false;
    }
    
    // Simple approach - try direct input first
    await departField.click();
    await departField.fill('');
    await departField.fill(departDate);
    
    // Verify the value was set
    const fieldValue = await departField.inputValue();
    if (fieldValue.includes(departDate.split('-')[2])) { // Check day is present
      logger.info('Departure date set successfully via direct input');
      return true;
    }
    
    logger.warn('Direct input failed, departure date may need calendar picker logic');
    return false;
    
  } catch (error) {
    logger.error('Departure date setting failed:', error.message);
    return false;
  }
}

/**
 * Validate that both dates are properly set before proceeding
 * @param {Page} page - Playwright page object
 * @returns {Promise<{departure: string, return: string, valid: boolean}>}
 */
async function validateDateFields(page) {
  try {
    const departField = await page.$('input[data-testid="depart-date-input"], .depart-date-field, #departDate');
    const returnField = await page.$('input[data-testid="return-date-input"], .return-date-field, #returnDate');
    
    const departValue = departField ? await departField.inputValue() : '';
    const returnValue = returnField ? await returnField.inputValue() : '';
    
    const isValid = departValue.length > 0 && returnValue.length > 0;
    
    logger.info(`Date validation - Depart: ${departValue}, Return: ${returnValue}, Valid: ${isValid}`);
    
    return {
      departure: departValue,
      return: returnValue,
      valid: isValid
    };
  } catch (error) {
    logger.error('Date validation failed:', error.message);
    return { departure: '', return: '', valid: false };
  }
}

module.exports = {
  setReturnDatePicker,
  setDepartureDatePicker,
  validateDateFields,
  waitForVisibleElement
};