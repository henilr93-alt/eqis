const logger = require('../utils/logger');

/**
 * Enhanced result detection logic for Search Pulse Engine
 * Properly identifies successful flight search results with prices and booking buttons
 */

/**
 * Detects if flight search results are present and valid
 * @param {Page} page - Playwright page object
 * @returns {Object} Detection result with success flag and details
 */
async function detectFlightResults(page) {
  try {
    // Wait a moment for results to stabilize
    await page.waitForTimeout(2000);
    
    // Primary detection: Look for flight cards with prices
    const flightCardsWithPrices = await page.locator('div[data-testid*="flight"], div[class*="flight"], div[class*="FlightCard"]').count();
    
    if (flightCardsWithPrices > 0) {
      // Verify prices are present
      const priceElements = await page.locator('span:has-text("₹"), div:has-text("₹"), text="₹"').count();
      
      if (priceElements > 0) {
        // Check for booking/select buttons
        const bookingButtons = await page.locator(
          'button:has-text("Book"), button:has-text("Select"), button:has-text("Choose"), ' +
          'a:has-text("Book"), a:has-text("Select"), a:has-text("Choose")'
        ).count();
        
        if (bookingButtons > 0) {
          logger.info(`Flight results detected: ${flightCardsWithPrices} cards, ${priceElements} prices, ${bookingButtons} booking buttons`);
          return {
            success: true,
            resultCount: flightCardsWithPrices,
            priceCount: priceElements,
            bookingButtonCount: bookingButtons,
            reason: 'Valid flight results with prices and booking options'
          };
        }
      }
    }
    
    // Secondary detection: Look for alternative result layouts
    const alternativeResults = await page.locator(
      '[data-testid*="result"], [class*="result"], [class*="card"][class*="flight"]'
    ).count();
    
    if (alternativeResults > 0) {
      const hasPrices = await page.locator('text=/₹[0-9,]+/').count() > 0;
      if (hasPrices) {
        logger.info(`Alternative flight results detected: ${alternativeResults} results with prices`);
        return {
          success: true,
          resultCount: alternativeResults,
          reason: 'Alternative result layout detected with prices'
        };
      }
    }
    
    // Check for "no results" or error messages
    const noResultsMessages = await page.locator(
      'text="No flights found", text="No results", text="Sorry", [class*="no-result"], [class*="error"]'
    ).count();
    
    if (noResultsMessages > 0) {
      logger.info('No results message detected');
      return {
        success: false,
        reason: 'No flights found message displayed',
        noResultsDetected: true
      };
    }
    
    // Default case - results unclear
    logger.warn('Flight results detection inconclusive');
    return {
      success: false,
      reason: 'Could not detect valid flight results or clear no-results state',
      ambiguous: true
    };
    
  } catch (error) {
    logger.error('Error in flight result detection:', error.message);
    return {
      success: false,
      reason: `Detection error: ${error.message}`,
      error: true
    };
  }
}

/**
 * Detects if hotel search results are present and valid
 * @param {Page} page - Playwright page object
 * @returns {Object} Detection result with success flag and details
 */
async function detectHotelResults(page) {
  try {
    // Wait for results to load
    await page.waitForTimeout(2000);
    
    // Look for hotel cards/listings
    const hotelCards = await page.locator(
      'div[data-testid*="hotel"], div[class*="hotel"], div[class*="HotelCard"], div[class*="property"]'
    ).count();
    
    if (hotelCards > 0) {
      // Verify prices are shown
      const priceElements = await page.locator('span:has-text("₹"), div:has-text("₹"), text="₹"').count();
      
      if (priceElements > 0) {
        logger.info(`Hotel results detected: ${hotelCards} hotels, ${priceElements} prices`);
        return {
          success: true,
          resultCount: hotelCards,
          priceCount: priceElements,
          reason: 'Valid hotel results with prices'
        };
      }
    }
    
    // Check for no results state
    const noResultsMessages = await page.locator(
      'text="No hotels found", text="No properties", text="No results", [class*="no-result"]'
    ).count();
    
    if (noResultsMessages > 0) {
      return {
        success: false,
        reason: 'No hotels found',
        noResultsDetected: true
      };
    }
    
    return {
      success: false,
      reason: 'Could not detect valid hotel results',
      ambiguous: true
    };
    
  } catch (error) {
    logger.error('Error in hotel result detection:', error.message);
    return {
      success: false,
      reason: `Hotel detection error: ${error.message}`,
      error: true
    };
  }
}

/**
 * Generic result detection that tries both flight and hotel patterns
 * @param {Page} page - Playwright page object
 * @param {string} searchType - 'flight' or 'hotel' or 'auto'
 * @returns {Object} Detection result
 */
async function detectSearchResults(page, searchType = 'auto') {
  if (searchType === 'flight') {
    return await detectFlightResults(page);
  }
  
  if (searchType === 'hotel') {
    return await detectHotelResults(page);
  }
  
  // Auto-detect: try flight first, then hotel
  const flightResult = await detectFlightResults(page);
  if (flightResult.success) {
    return flightResult;
  }
  
  const hotelResult = await detectHotelResults(page);
  if (hotelResult.success) {
    return hotelResult;
  }
  
  // Return the more informative result
  return flightResult.ambiguous ? hotelResult : flightResult;
}

module.exports = {
  detectFlightResults,
  detectHotelResults,
  detectSearchResults
};