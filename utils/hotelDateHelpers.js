const { logger } = require('./logger');

/**
 * Enhanced hotel date picker interaction with robust fallback strategies
 * Handles Etrav's dynamic calendar widgets with proper timing and verification
 */

/**
 * Formats date for hotel search forms (DD/MM/YYYY format)
 */
function formatHotelDate(date) {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Waits for element to be visible and stable before interaction
 */
async function waitForElementStable(page, selector, timeout = 5000) {
  await page.waitForSelector(selector, { visible: true, timeout });
  // Additional wait for any animations to complete
  await page.waitForTimeout(500);
  return await page.$(selector);
}

/**
 * Verifies that a date field has the expected value
 */
async function verifyDateFieldValue(page, selector, expectedDate) {
  try {
    const actualValue = await page.$eval(selector, el => el.value || el.textContent?.trim() || '');
    const formatted = formatHotelDate(expectedDate);
    logger.info(`Date field verification: expected=${formatted}, actual=${actualValue}`);
    return actualValue.includes(formatted) || actualValue.includes(expectedDate.toISOString().split('T')[0]);
  } catch (error) {
    logger.warn(`Date field verification failed: ${error.message}`);
    return false;
  }
}

/**
 * Enhanced date picker interaction with multiple strategies
 */
async function setHotelDate(page, dateFieldSelector, calendarSelector, targetDate, fieldType = 'checkin') {
  logger.info(`Setting hotel ${fieldType} date: ${targetDate}`);
  
  try {
    // Strategy 1: Click date field and wait for calendar
    const dateField = await waitForElementStable(page, dateFieldSelector);
    await dateField.click();
    logger.info(`Clicked ${fieldType} date field`);
    
    // Wait longer for calendar to appear and stabilize
    await page.waitForTimeout(1500);
    
    // Check if calendar appeared
    const calendarVisible = await page.$(calendarSelector).then(el => !!el).catch(() => false);
    
    if (calendarVisible) {
      logger.info('Calendar opened, attempting date selection');
      
      // Strategy 1A: Use calendar picker
      const success = await selectDateFromCalendar(page, calendarSelector, targetDate);
      
      if (success) {
        // Verify the date was set correctly
        await page.waitForTimeout(1000);
        const verified = await verifyDateFieldValue(page, dateFieldSelector, targetDate);
        if (verified) {
          logger.info(`Successfully set ${fieldType} date via calendar`);
          return true;
        }
      }
    }
    
    // Strategy 2: Direct input field manipulation
    logger.warn('Calendar selection failed or calendar not visible, trying direct input');
    
    // Clear the field first
    await dateField.click();
    await page.waitForTimeout(300);
    await dateField.focus();
    await page.waitForTimeout(300);
    
    // Clear existing content
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.waitForTimeout(200);
    
    // Type the formatted date
    const formattedDate = formatHotelDate(targetDate);
    await page.keyboard.type(formattedDate, { delay: 100 });
    await page.waitForTimeout(500);
    
    // Trigger change event
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1000);
    
    // Verify direct input worked
    const directInputVerified = await verifyDateFieldValue(page, dateFieldSelector, targetDate);
    if (directInputVerified) {
      logger.info(`Successfully set ${fieldType} date via direct input`);
      return true;
    }
    
    // Strategy 3: Alternative selectors and attribute setting
    logger.warn('Direct input failed, trying attribute manipulation');
    
    await page.evaluate((selector, date) => {
      const element = document.querySelector(selector);
      if (element) {
        const formatted = new Date(date).toISOString().split('T')[0];
        element.value = formatted;
        element.setAttribute('value', formatted);
        // Trigger events
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
      }
    }, dateFieldSelector, targetDate);
    
    await page.waitForTimeout(1000);
    const attributeVerified = await verifyDateFieldValue(page, dateFieldSelector, targetDate);
    
    if (attributeVerified) {
      logger.info(`Successfully set ${fieldType} date via attribute manipulation`);
      return true;
    }
    
    logger.error(`All strategies failed for ${fieldType} date setting`);
    return false;
    
  } catch (error) {
    logger.error(`Error setting hotel ${fieldType} date: ${error.message}`);
    return false;
  }
}

/**
 * Selects a date from an open calendar widget
 */
async function selectDateFromCalendar(page, calendarSelector, targetDate) {
  try {
    const target = new Date(targetDate);
    const targetDay = target.getDate();
    const targetMonth = target.getMonth();
    const targetYear = target.getFullYear();
    
    // Look for date cells in the calendar
    const dateCellSelectors = [
      `${calendarSelector} [data-date="${target.toISOString().split('T')[0]}"]`,
      `${calendarSelector} .calendar-day[data-day="${targetDay}"]`,
      `${calendarSelector} td:not(.disabled):has-text("${targetDay}")`,
      `${calendarSelector} .day:not(.disabled):has-text("${targetDay}")`
    ];
    
    for (const selector of dateCellSelectors) {
      try {
        const dateCell = await page.$(selector);
        if (dateCell) {
          await dateCell.click();
          await page.waitForTimeout(500);
          logger.info(`Clicked date cell with selector: ${selector}`);
          return true;
        }
      } catch (error) {
        // Continue to next selector
        continue;
      }
    }
    
    // Fallback: navigate month if needed and find day
    await navigateToTargetMonth(page, calendarSelector, targetMonth, targetYear);
    
    // Try to find and click the target day after navigation
    const dayElements = await page.$$(`.calendar-day, .day, td`);
    for (const element of dayElements) {
      const dayText = await element.textContent();
      if (dayText && parseInt(dayText.trim()) === targetDay) {
        const isDisabled = await element.getAttribute('class');
        if (!isDisabled?.includes('disabled')) {
          await element.click();
          await page.waitForTimeout(500);
          logger.info(`Successfully clicked day ${targetDay}`);
          return true;
        }
      }
    }
    
    return false;
  } catch (error) {
    logger.error(`Calendar date selection failed: ${error.message}`);
    return false;
  }
}

/**
 * Navigates calendar to target month/year
 */
async function navigateToTargetMonth(page, calendarSelector, targetMonth, targetYear) {
  try {
    // Look for month navigation buttons
    const nextButton = await page.$(`${calendarSelector} .next, ${calendarSelector} .arrow-right, ${calendarSelector} button[aria-label*="next"]`);
    const prevButton = await page.$(`${calendarSelector} .prev, ${calendarSelector} .arrow-left, ${calendarSelector} button[aria-label*="prev"]`);
    
    // Simple navigation logic - click next/prev a few times if needed
    const currentDate = new Date();
    const monthDiff = (targetYear - currentDate.getFullYear()) * 12 + (targetMonth - currentDate.getMonth());
    
    if (monthDiff > 0 && nextButton) {
      for (let i = 0; i < Math.min(Math.abs(monthDiff), 6); i++) {
        await nextButton.click();
        await page.waitForTimeout(300);
      }
    } else if (monthDiff < 0 && prevButton) {
      for (let i = 0; i < Math.min(Math.abs(monthDiff), 6); i++) {
        await prevButton.click();
        await page.waitForTimeout(300);
      }
    }
    
  } catch (error) {
    logger.warn(`Calendar navigation failed: ${error.message}`);
  }
}

/**
 * Sets both check-in and check-out dates for hotel search
 */
async function setHotelDates(page, checkinDate, checkoutDate) {
  logger.info('Setting hotel check-in and check-out dates');
  
  const checkinSelectors = [
    'input[name="checkin"]',
    'input[placeholder*="Check in"]',
    'input[placeholder*="Check-in"]',
    '.checkin-date input',
    '#checkin',
    '.date-picker-checkin input'
  ];
  
  const checkoutSelectors = [
    'input[name="checkout"]',
    'input[placeholder*="Check out"]',
    'input[placeholder*="Check-out"]',
    '.checkout-date input',
    '#checkout',
    '.date-picker-checkout input'
  ];
  
  const calendarSelectors = [
    '.calendar-popup',
    '.date-picker-popup',
    '.calendar-container',
    '[class*="calendar"]',
    '.datepicker'
  ];
  
  let checkinSuccess = false;
  let checkoutSuccess = false;
  
  // Try each checkin selector
  for (const checkinSelector of checkinSelectors) {
    const checkinExists = await page.$(checkinSelector);
    if (checkinExists) {
      for (const calendarSelector of calendarSelectors) {
        checkinSuccess = await setHotelDate(page, checkinSelector, calendarSelector, checkinDate, 'checkin');
        if (checkinSuccess) break;
      }
      if (checkinSuccess) break;
    }
  }
  
  if (!checkinSuccess) {
    logger.error('Failed to set check-in date with all available selectors');
    return false;
  }
  
  // Wait a bit before setting checkout date
  await page.waitForTimeout(1000);
  
  // Try each checkout selector
  for (const checkoutSelector of checkoutSelectors) {
    const checkoutExists = await page.$(checkoutSelector);
    if (checkoutExists) {
      for (const calendarSelector of calendarSelectors) {
        checkoutSuccess = await setHotelDate(page, checkoutSelector, calendarSelector, checkoutDate, 'checkout');
        if (checkoutSuccess) break;
      }
      if (checkoutSuccess) break;
    }
  }
  
  if (!checkoutSuccess) {
    logger.error('Failed to set check-out date with all available selectors');
    return false;
  }
  
  logger.info('Successfully set both hotel dates');
  return true;
}

module.exports = {
  formatHotelDate,
  setHotelDate,
  setHotelDates,
  verifyDateFieldValue,
  waitForElementStable
};