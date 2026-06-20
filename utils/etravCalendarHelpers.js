const logger = require('./logger');
const { retry } = require('./retry');

/**
 * Calendar interaction helpers for eTrav flight/hotel booking automation.
 * Handles date picking across different calendar layouts and viewport positioning.
 */

class CalendarHelpers {
  constructor(page) {
    this.page = page;
  }

  /**
   * Scroll element into view and ensure it's clickable
   * @param {Object} element - Playwright element handle
   */
  async ensureElementVisible(element) {
    try {
      // Scroll element into view center
      await element.scrollIntoViewIfNeeded();
      
      // Small delay to ensure scroll completes
      await this.page.waitForTimeout(300);
      
      // Verify element is in viewport
      const box = await element.boundingBox();
      if (!box) {
        throw new Error('Element has no bounding box after scroll');
      }
      
      logger.info(`Element positioned at ${box.x},${box.y} (${box.width}x${box.height})`);
      return true;
    } catch (error) {
      logger.error(`Failed to ensure element visibility: ${error.message}`);
      return false;
    }
  }

  /**
   * Click calendar date with viewport safety
   * @param {string} dateSelector - CSS selector for the date
   * @param {string} dateText - Expected date text for validation
   */
  async clickCalendarDate(dateSelector, dateText = null) {
    try {
      await this.page.waitForSelector(dateSelector, { timeout: 5000 });
      const dateElement = await this.page.$(dateSelector);
      
      if (!dateElement) {
        throw new Error(`Date element not found: ${dateSelector}`);
      }
      
      // Ensure element is visible in viewport
      const isVisible = await this.ensureElementVisible(dateElement);
      if (!isVisible) {
        throw new Error('Could not scroll date element into view');
      }
      
      // Validate date text if provided
      if (dateText) {
        const actualText = await dateElement.textContent();
        if (!actualText?.includes(dateText)) {
          logger.warn(`Date text mismatch: expected "${dateText}", got "${actualText}"`);
        }
      }
      
      // Click with retry for robustness
      await retry(async () => {
        await dateElement.click();
        logger.info(`Clicked calendar date: ${dateSelector}`);
      }, 3, 500);
      
      return true;
    } catch (error) {
      logger.error(`Failed to click calendar date ${dateSelector}: ${error.message}`);
      return false;
    }
  }

  /**
   * Navigate to specific month/year in calendar
   * @param {number} targetMonth - Month (1-12)
   * @param {number} targetYear - Year (e.g., 2024)
   */
  async navigateToMonth(targetMonth, targetYear) {
    try {
      // Common selectors for month/year navigation
      const monthYearSelector = '.calendar-header, .datepicker-header, .month-year-display';
      const nextButtonSelector = '.next-month, .calendar-next, .datepicker-next';
      const prevButtonSelector = '.prev-month, .calendar-prev, .datepicker-prev';
      
      let attempts = 0;
      const maxAttempts = 24; // Max 2 years navigation
      
      while (attempts < maxAttempts) {
        // Get current month/year display
        const monthYearText = await this.page.textContent(monthYearSelector).catch(() => '');
        logger.info(`Current calendar view: ${monthYearText}`);
        
        // Parse current month/year (this is simplified, may need adjustment per site)
        const currentDate = new Date();
        const currentMonth = currentDate.getMonth() + 1;
        const currentYear = currentDate.getFullYear();
        
        if (currentMonth === targetMonth && currentYear === targetYear) {
          logger.info(`Reached target month: ${targetMonth}/${targetYear}`);
          return true;
        }
        
        // Determine navigation direction
        const targetDate = new Date(targetYear, targetMonth - 1);
        const currentDateObj = new Date(currentYear, currentMonth - 1);
        
        if (targetDate > currentDateObj) {
          // Navigate forward
          const nextBtn = await this.page.$(nextButtonSelector);
          if (nextBtn) {
            await this.ensureElementVisible(nextBtn);
            await nextBtn.click();
            logger.info('Navigated to next month');
          }
        } else {
          // Navigate backward
          const prevBtn = await this.page.$(prevButtonSelector);
          if (prevBtn) {
            await this.ensureElementVisible(prevBtn);
            await prevBtn.click();
            logger.info('Navigated to previous month');
          }
        }
        
        await this.page.waitForTimeout(500); // Allow calendar to update
        attempts++;
      }
      
      logger.error(`Failed to navigate to ${targetMonth}/${targetYear} after ${maxAttempts} attempts`);
      return false;
    } catch (error) {
      logger.error(`Calendar navigation error: ${error.message}`);
      return false;
    }
  }

  /**
   * Select departure date with smart calendar handling
   * @param {string} dateString - Date in YYYY-MM-DD format
   * @param {string} calendarType - 'departure' or 'return'
   */
  async selectDate(dateString, calendarType = 'departure') {
    try {
      const [year, month, day] = dateString.split('-').map(Number);
      logger.info(`Selecting ${calendarType} date: ${day}/${month}/${year}`);
      
      // Navigate to correct month/year first
      await this.navigateToMonth(month, year);
      
      // Common date selectors - try multiple patterns
      const daySelectors = [
        `[data-date="${dateString}"]`,
        `[data-day="${day}"]`,
        `.day:has-text("${day}")`,
        `.calendar-day:has-text("${day}")`,
        `td:has-text("${day}"):not(.other-month)`,
        `.datepicker-day:has-text("${day}")`
      ];
      
      for (const selector of daySelectors) {
        try {
          const dateElement = await this.page.$(selector);
          if (dateElement) {
            const isClickable = await this.clickCalendarDate(selector, day.toString());
            if (isClickable) {
              logger.info(`Successfully selected ${calendarType} date using selector: ${selector}`);
              return true;
            }
          }
        } catch (selectorError) {
          logger.debug(`Selector ${selector} failed: ${selectorError.message}`);
          continue;
        }
      }
      
      logger.error(`Could not select ${calendarType} date ${dateString} with any selector`);
      return false;
    } catch (error) {
      logger.error(`Date selection failed for ${dateString}: ${error.message}`);
      return false;
    }
  }

  /**
   * Handle roundtrip date selection (departure + return)
   * @param {string} departureDate - Departure date (YYYY-MM-DD)
   * @param {string} returnDate - Return date (YYYY-MM-DD)
   */
  async selectRoundtripDates(departureDate, returnDate) {
    try {
      logger.info(`Selecting roundtrip: ${departureDate} → ${returnDate}`);
      
      // Select departure date first
      const departureSuccess = await this.selectDate(departureDate, 'departure');
      if (!departureSuccess) {
        return false;
      }
      
      // Wait for calendar to potentially refresh
      await this.page.waitForTimeout(1000);
      
      // Select return date
      const returnSuccess = await this.selectDate(returnDate, 'return');
      if (!returnSuccess) {
        return false;
      }
      
      logger.info('Roundtrip dates selected successfully');
      return true;
    } catch (error) {
      logger.error(`Roundtrip selection failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Close calendar overlay/popup
   */
  async closeCalendar() {
    try {
      const closeSelectors = [
        '.calendar-close',
        '.datepicker-close', 
        '.close-calendar',
        '[data-testid="calendar-close"]',
        '.modal-close'
      ];
      
      for (const selector of closeSelectors) {
        const closeBtn = await this.page.$(selector);
        if (closeBtn) {
          await this.ensureElementVisible(closeBtn);
          await closeBtn.click();
          logger.info(`Calendar closed using: ${selector}`);
          return true;
        }
      }
      
      // Try escape key as fallback
      await this.page.keyboard.press('Escape');
      logger.info('Calendar closed with Escape key');
      return true;
    } catch (error) {
      logger.error(`Failed to close calendar: ${error.message}`);
      return false;
    }
  }

  /**
   * Validate calendar is in expected state
   * @param {string} expectedMonth - Expected month name
   * @param {number} expectedYear - Expected year
   */
  async validateCalendarState(expectedMonth, expectedYear) {
    try {
      const headerText = await this.page.textContent('.calendar-header, .datepicker-header').catch(() => '');
      const hasExpectedMonth = headerText.toLowerCase().includes(expectedMonth.toLowerCase());
      const hasExpectedYear = headerText.includes(expectedYear.toString());
      
      if (hasExpectedMonth && hasExpectedYear) {
        logger.info(`Calendar state validated: ${expectedMonth} ${expectedYear}`);
        return true;
      } else {
        logger.warn(`Calendar state mismatch. Header: "${headerText}", Expected: ${expectedMonth} ${expectedYear}`);
        return false;
      }
    } catch (error) {
      logger.error(`Calendar validation failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Get available dates in current calendar view
   * @returns {Array} Array of available date objects
   */
  async getAvailableDates() {
    try {
      const dateElements = await this.page.$$('.calendar-day:not(.disabled), .datepicker-day:not(.disabled)');
      const availableDates = [];
      
      for (const element of dateElements) {
        const dateText = await element.textContent();
        const dataDate = await element.getAttribute('data-date');
        
        availableDates.push({
          text: dateText?.trim(),
          dataDate: dataDate,
          element: element
        });
      }
      
      logger.info(`Found ${availableDates.length} available dates in calendar`);
      return availableDates;
    } catch (error) {
      logger.error(`Failed to get available dates: ${error.message}`);
      return [];
    }
  }

  /**
   * Smart date picker that tries multiple strategies
   * @param {Object} dateConfig - Configuration object
   * @param {string} dateConfig.date - Target date (YYYY-MM-DD)
   * @param {string} dateConfig.inputSelector - Input field selector to click first
   * @param {boolean} dateConfig.isReturn - Whether this is return date selection
   */
  async smartDateSelect(dateConfig) {
    try {
      const { date, inputSelector, isReturn = false } = dateConfig;
      
      // Click input field to open calendar
      if (inputSelector) {
        const inputElement = await this.page.$(inputSelector);
        if (inputElement) {
          await this.ensureElementVisible(inputElement);
          await inputElement.click();
          logger.info(`Clicked date input: ${inputSelector}`);
          
          // Wait for calendar to appear
          await this.page.waitForTimeout(1000);
        }
      }
      
      // Select the date
      const success = await this.selectDate(date, isReturn ? 'return' : 'departure');
      
      if (success) {
        // Small delay before closing
        await this.page.waitForTimeout(500);
        
        // Try to close calendar
        await this.closeCalendar();
      }
      
      return success;
    } catch (error) {
      logger.error(`Smart date select failed: ${error.message}`);
      return false;
    }
  }
}

module.exports = {
  CalendarHelpers,
  
  /**
   * Factory function to create calendar helper instance
   * @param {Object} page - Playwright page instance
   * @returns {CalendarHelpers} Calendar helper instance
   */
  createCalendarHelper: (page) => new CalendarHelpers(page),
  
  /**
   * Utility function for quick date selection
   * @param {Object} page - Playwright page instance
   * @param {string} date - Date string (YYYY-MM-DD)
   * @param {string} inputSelector - Input selector to click
   * @param {boolean} isReturn - Is return date
   */
  quickDateSelect: async (page, date, inputSelector, isReturn = false) => {
    const helper = new CalendarHelpers(page);
    return await helper.smartDateSelect({ date, inputSelector, isReturn });
  }
};