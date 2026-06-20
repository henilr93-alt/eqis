const logger = require('./logger');
const { waitForSelector, clickElement, typeText } = require('./etravFormHelpers');

/**
 * Enhanced date picker utilities for Etrav platform with improved retry logic
 * Addresses SPF failures caused by return date picker timing issues
 */

/**
 * Sets departure date in Etrav date picker
 * @param {Object} page - Playwright page object
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {Object} options - Configuration options
 * @returns {Promise<boolean>} Success status
 */
async function setDepartureDate(page, date, options = {}) {
  const { timeout = 10000, retries = 5 } = options;
  
  try {
    logger.log('Setting departure date:', date);
    
    // Wait for departure date picker to be available
    await waitForSelector(page, '[data-testid="departure-date-picker"], .departure-date-input, #departureDate', { timeout });
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // Click to open departure date picker
        const departurePicker = await page.$('[data-testid="departure-date-picker"], .departure-date-input, #departureDate');
        if (departurePicker) {
          await departurePicker.click();
          await page.waitForTimeout(300); // Allow picker to open
          
          // Set the date using calendar navigation
          const success = await setCalendarDate(page, date, 'departure');
          if (success) {
            logger.log(`Departure date set successfully on attempt ${attempt}`);
            return true;
          }
        }
        
        if (attempt < retries) {
          logger.log(`Departure date attempt ${attempt} failed, retrying...`);
          await page.waitForTimeout(500 * attempt); // Progressive delay
        }
      } catch (error) {
        logger.log(`Departure date attempt ${attempt} error:`, error.message);
        if (attempt === retries) throw error;
        await page.waitForTimeout(500 * attempt);
      }
    }
    
    throw new Error(`Failed to set departure date after ${retries} attempts`);
    
  } catch (error) {
    logger.log('Error setting departure date:', error.message);
    return false;
  }
}

/**
 * Sets return date in Etrav date picker with enhanced retry logic for SPF prevention
 * @param {Object} page - Playwright page object
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {Object} options - Configuration options
 * @returns {Promise<boolean>} Success status
 */
async function setReturnDate(page, date, options = {}) {
  const { timeout = 10000, retries = 8 } = options; // Increased from 3 to 8 retries
  
  try {
    logger.log('Setting return date:', date);
    
    // Wait for return date picker to be available
    await waitForSelector(page, '[data-testid="return-date-picker"], .return-date-input, #returnDate', { timeout });
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // Progressive delay between attempts to handle calendar UI timing
        const attemptDelay = Math.min(500 + (attempt - 1) * 250, 2000); // 500ms → 2000ms max
        
        if (attempt > 1) {
          logger.log(`Return date attempt ${attempt}/${retries} after ${attemptDelay}ms delay`);
          await page.waitForTimeout(attemptDelay);
        }
        
        // Click to open return date picker
        const returnPicker = await page.$('[data-testid="return-date-picker"], .return-date-input, #returnDate');
        if (returnPicker) {
          await returnPicker.click();
          
          // Enhanced wait for calendar UI to stabilize
          await page.waitForTimeout(400 + (attempt * 50)); // Progressive calendar wait
          
          // Check if calendar is actually visible before proceeding
          const calendarVisible = await page.$('.react-datepicker, .calendar-container, [class*="calendar"]');
          if (!calendarVisible && attempt < retries) {
            logger.log(`Calendar not visible on attempt ${attempt}, retrying picker click`);
            continue;
          }
          
          // Set the date using calendar navigation
          const success = await setCalendarDate(page, date, 'return');
          if (success) {
            // Verify the date was actually set by checking input value
            await page.waitForTimeout(200);
            const inputValue = await returnPicker.inputValue().catch(() => '');
            if (inputValue && inputValue.includes(date.split('-')[2])) {
              logger.log(`Return date set and verified successfully on attempt ${attempt}`);
              return true;
            } else {
              logger.log(`Return date set but verification failed on attempt ${attempt}`);
              if (attempt < retries) continue;
            }
          }
        }
        
        if (attempt < retries) {
          logger.log(`Return date attempt ${attempt} failed, retrying with longer delay...`);
        }
      } catch (error) {
        logger.log(`Return date attempt ${attempt} error:`, error.message);
        if (attempt === retries) throw error;
        
        // Close any open modals/calendars before retry
        try {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
        } catch (e) {
          // Ignore escape key errors
        }
      }
    }
    
    throw new Error(`Failed to set return date after ${retries} attempts with progressive delays`);
    
  } catch (error) {
    logger.log('Error setting return date:', error.message);
    return false;
  }
}

/**
 * Sets date in calendar widget with enhanced timing handling
 * @param {Object} page - Playwright page object
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {string} type - 'departure' or 'return'
 * @returns {Promise<boolean>} Success status
 */
async function setCalendarDate(page, date, type = 'departure') {
  try {
    const [year, month, day] = date.split('-');
    const targetMonth = parseInt(month);
    const targetYear = parseInt(year);
    const targetDay = parseInt(day);
    
    logger.log(`Setting ${type} calendar date: ${targetDay}/${targetMonth}/${targetYear}`);
    
    // Wait for calendar to be visible with enhanced detection
    const calendarSelectors = [
      '.react-datepicker',
      '.calendar-container',
      '[class*="calendar"]',
      '[class*="datepicker"]',
      '.date-picker-popup'
    ];
    
    let calendarElement = null;
    for (const selector of calendarSelectors) {
      calendarElement = await page.$(selector);
      if (calendarElement) break;
    }
    
    if (!calendarElement) {
      logger.log('Calendar element not found with any selector');
      return false;
    }
    
    // Enhanced month/year navigation with better timing
    await navigateToTargetMonth(page, targetMonth, targetYear);
    
    // Click the target day with improved day selection
    const dayClicked = await clickTargetDay(page, targetDay);
    
    if (dayClicked) {
      // Additional wait for calendar to close and value to be set
      await page.waitForTimeout(300);
      logger.log(`${type} date set successfully in calendar`);
      return true;
    }
    
    return false;
    
  } catch (error) {
    logger.log(`Error setting ${type} calendar date:`, error.message);
    return false;
  }
}

/**
 * Navigates calendar to target month and year
 * @param {Object} page - Playwright page object
 * @param {number} targetMonth - Target month (1-12)
 * @param {number} targetYear - Target year
 */
async function navigateToTargetMonth(page, targetMonth, targetYear) {
  try {
    // Get current calendar state
    const monthYearText = await page.$eval(
      '.react-datepicker__current-month, .calendar-month-year, [class*="month"][class*="year"]',
      el => el.textContent
    ).catch(() => '');
    
    logger.log('Current calendar month/year:', monthYearText);
    
    // Navigate to correct month/year
    // This is a simplified navigation - could be enhanced based on specific calendar implementation
    const maxNavigations = 24; // Prevent infinite loops
    let navigationCount = 0;
    
    while (navigationCount < maxNavigations) {
      // Check if we're at the target month/year
      const currentText = await page.$eval(
        '.react-datepicker__current-month, .calendar-month-year, [class*="month"][class*="year"]',
        el => el.textContent
      ).catch(() => '');
      
      if (currentText.includes(targetYear.toString()) && 
          currentText.includes(getMonthName(targetMonth))) {
        break;
      }
      
      // Navigate forward or backward
      const needsForward = shouldNavigateForward(currentText, targetMonth, targetYear);
      const navButton = needsForward ? 
        '.react-datepicker__navigation--next' : 
        '.react-datepicker__navigation--previous';
      
      const navElement = await page.$(navButton);
      if (navElement) {
        await navElement.click();
        await page.waitForTimeout(200); // Allow calendar to update
      } else {
        break;
      }
      
      navigationCount++;
    }
    
  } catch (error) {
    logger.log('Error navigating calendar:', error.message);
  }
}

/**
 * Clicks the target day in the calendar
 * @param {Object} page - Playwright page object
 * @param {number} targetDay - Target day of month
 * @returns {Promise<boolean>} Success status
 */
async function clickTargetDay(page, targetDay) {
  try {
    // Multiple selectors for day elements
    const daySelectors = [
      `[aria-label*="${targetDay}"]`,
      `.react-datepicker__day--0${targetDay.toString().padStart(2, '0')}`,
      `[data-day="${targetDay}"]`,
      `.day[data-date*="${targetDay}"]`
    ];
    
    for (const selector of daySelectors) {
      const dayElements = await page.$$(selector);
      for (const dayElement of dayElements) {
        const dayText = await dayElement.textContent();
        if (dayText.trim() === targetDay.toString()) {
          await dayElement.click();
          logger.log(`Clicked day ${targetDay}`);
          return true;
        }
      }
    }
    
    // Fallback: try generic day selector
    const genericDays = await page.$$('.react-datepicker__day, .calendar-day, [class*="day"]');
    for (const dayElement of genericDays) {
      const dayText = await dayElement.textContent();
      if (dayText.trim() === targetDay.toString()) {
        // Check if day is not disabled
        const isDisabled = await dayElement.evaluate(el => 
          el.classList.contains('disabled') || 
          el.classList.contains('react-datepicker__day--disabled') ||
          el.hasAttribute('disabled')
        );
        
        if (!isDisabled) {
          await dayElement.click();
          logger.log(`Clicked day ${targetDay} (generic selector)`);
          return true;
        }
      }
    }
    
    logger.log(`Could not find clickable day ${targetDay}`);
    return false;
    
  } catch (error) {
    logger.log(`Error clicking day ${targetDay}:`, error.message);
    return false;
  }
}

/**
 * Gets month name from number
 * @param {number} monthNum - Month number (1-12)
 * @returns {string} Month name
 */
function getMonthName(monthNum) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  return months[monthNum - 1] || '';
}

/**
 * Determines if calendar should navigate forward
 * @param {string} currentText - Current month/year display text
 * @param {number} targetMonth - Target month
 * @param {number} targetYear - Target year
 * @returns {boolean} True if should navigate forward
 */
function shouldNavigateForward(currentText, targetMonth, targetYear) {
  // Simple heuristic - could be enhanced based on actual calendar behavior
  const currentYear = new Date().getFullYear();
  return targetYear > currentYear || 
         (targetYear === currentYear && targetMonth > new Date().getMonth() + 1);
}

/**
 * Validates if date picker is available and functional
 * @param {Object} page - Playwright page object
 * @param {string} type - 'departure' or 'return'
 * @returns {Promise<boolean>} Availability status
 */
async function isDatePickerAvailable(page, type = 'departure') {
  try {
    const selector = type === 'departure' ? 
      '[data-testid="departure-date-picker"], .departure-date-input, #departureDate' :
      '[data-testid="return-date-picker"], .return-date-input, #returnDate';
    
    const element = await page.$(selector);
    if (!element) return false;
    
    // Check if element is visible and enabled
    const isVisible = await element.isVisible();
    const isEnabled = await element.isEnabled();
    
    return isVisible && isEnabled;
    
  } catch (error) {
    logger.log(`Error checking ${type} date picker availability:`, error.message);
    return false;
  }
}

/**
 * Clears date picker value
 * @param {Object} page - Playwright page object
 * @param {string} type - 'departure' or 'return'
 * @returns {Promise<boolean>} Success status
 */
async function clearDatePicker(page, type = 'departure') {
  try {
    const selector = type === 'departure' ? 
      '[data-testid="departure-date-picker"], .departure-date-input, #departureDate' :
      '[data-testid="return-date-picker"], .return-date-input, #returnDate';
    
    const element = await page.$(selector);
    if (element) {
      await element.click();
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Delete');
      await page.waitForTimeout(200);
      return true;
    }
    
    return false;
    
  } catch (error) {
    logger.log(`Error clearing ${type} date picker:`, error.message);
    return false;
  }
}

module.exports = {
  setDepartureDate,
  setReturnDate,
  setCalendarDate,
  isDatePickerAvailable,
  clearDatePicker,
  navigateToTargetMonth,
  clickTargetDay,
  getMonthName,
  shouldNavigateForward
};