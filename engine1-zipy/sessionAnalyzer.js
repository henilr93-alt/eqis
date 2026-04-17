const { callClaude } = require('../utils/tokenOptimizer');
const { PLATFORM_CONTEXT } = require('../config/platformContext');
const logger = require('../utils/logger');

const ANALYSIS_PROMPT = `${PLATFORM_CONTEXT}
Analyze this real user session recording. Session selected because: {watchFocus}

Return ONLY JSON:
{
  "sessionId": string,
  "productUsed": "flights"|"hotels"|"both"|"search_only"|"unknown",
  "journeyStage": "home"|"search"|"results"|"passenger_form"|"review"|"payment"|"confirmation"|"unknown",
  "completedToPayment": boolean,
  "dropOffStep": string|null,
  "timeOnProblematicPage": string|null,
  "searchPattern": {
    "flightType": "domestic"|"international"|"unknown",
    "origin": string|null, "destination": string|null,
    "cabinClass": "economy"|"business"|"unknown",
    "passengerCount": number|null, "filtersUsed": [string],
    "hotelDestination": string|null, "hotelStarRating": string|null, "stayDuration": number|null
  },
  "bugsObserved": [{"bugId": string, "type": string, "severity": "P0"|"P1"|"P2"|"P3", "title": string, "description": string, "pageWhere": string, "visibleInScreenshot": string, "devFixRequired": string}],
  "frictionPoints": [{"type": string, "location": string, "description": string, "agentImpact": string}],
  "uxProblems": [{"element": string, "problem": string, "recommendation": string, "priority": "HIGH"|"MEDIUM"|"LOW"}],
  "positives": [string]
}`;

async function analyze(page, session) {
  logger.info(`[ANALYZER] Analyzing session: ${session.sessionId}`);

  const screenshots = [];

  try {
    // Open session URL
    await page.goto(session.sessionUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Screenshot A: Session overview
    const screenshotA = await page.screenshot({ fullPage: false, encoding: 'base64' });
    screenshots.push(screenshotA);

    // Try Console/Errors tab
    const errorTabSelectors = [
      'button:has-text("Console")', 'button:has-text("Errors")',
      '[data-tab="console"]', '[data-tab="errors"]',
    ];
    for (const sel of errorTabSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForTimeout(1500);
        screenshots.push(await page.screenshot({ fullPage: false, encoding: 'base64' }));
        break;
      }
    }

    // Try Network tab
    const networkTabSelectors = [
      'button:has-text("Network")', '[data-tab="network"]',
    ];
    for (const sel of networkTabSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await page.waitForTimeout(1500);
        screenshots.push(await page.screenshot({ fullPage: false, encoding: 'base64' }));
        break;
      }
    }

    // Error markers on timeline (max 3)
    const markerSelectors = [
      '[class*="error-marker"]', '[class*="rage"]',
      '[class*="marker"][class*="error"]',
    ];
    let markersClicked = 0;
    for (const sel of markerSelectors) {
      if (markersClicked >= 3) break;
      const markers = await page.$$(sel);
      for (const marker of markers) {
        if (markersClicked >= 3) break;
        await marker.click();
        await page.waitForTimeout(1000);
        screenshots.push(await page.screenshot({ fullPage: false, encoding: 'base64' }));
        markersClicked++;
      }
    }

    // Send all screenshots to Claude Vision via tokenOptimizer
    const prompt = ANALYSIS_PROMPT.replace('{watchFocus}', session.watchFocus || 'General review');

    // Use the first screenshot for the API call (primary view)
    // Additional screenshots provide context but we send the main one
    const analysis = await callClaude({
      system: prompt,
      userText: `Session ${session.sessionId}. ${screenshots.length} screenshots captured. Analyze the session.`,
      imageBase64: screenshots[0],
      mode: 'DEEP',
      label: `zipy/sessionAnalysis/${session.sessionId}`,
    });

    if (analysis) {
      logger.info(`[ANALYZER] Session ${session.sessionId}: ${analysis.bugsObserved?.length || 0} bugs, stage: ${analysis.journeyStage}`);
      await new Promise(r => setTimeout(r, 3000)); // rate limit between sessions
      return analysis;
    }

    return createFallbackAnalysis(session);
  } catch (err) {
    logger.error(`[ANALYZER] Failed for ${session.sessionId}: ${err.message}`);
    return createFallbackAnalysis(session, err.message);
  }
}

function createFallbackAnalysis(session, error) {
  return {
    sessionId: session.sessionId,
    productUsed: 'unknown', journeyStage: 'unknown',
    completedToPayment: false, dropOffStep: null,
    timeOnProblematicPage: null, searchPattern: {},
    bugsObserved: [], frictionPoints: [], uxProblems: [], positives: [],
    error: error || 'analysis_failed',
  };
}

module.exports = { analyze };
