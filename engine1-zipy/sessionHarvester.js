const logger = require('../utils/logger');
const settings = require('../config/settings');
const screenshotter = require('../utils/screenshotter');

async function harvest(page) {
  const maxSessions = settings.ZIPY_SESSIONS_TO_HARVEST;
  logger.info(`[HARVESTER] Starting harvest for up to ${maxSessions} sessions...`);

  // Take screenshot before harvest for debugging
  try {
    await screenshotter.captureScreenshot(page, 'zipy-harvest-start');
    logger.info('[HARVESTER] Screenshot captured before harvest');
  } catch (error) {
    logger.warn(`[HARVESTER] Failed to capture screenshot: ${error.message}`);
  }

  // URL diagnostic logging
  const currentUrl = page.url();
  logger.info(`[HARVESTER] Current URL: ${currentUrl}`);
  
  if (!currentUrl || currentUrl === 'about:blank') {
    throw new Error('HARVEST_ERROR: No page loaded - URL is blank or missing');
  }

  // DOM structure analysis
  const domStats = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const rows = document.querySelectorAll('tr, [role="row"]');
    const listItems = document.querySelectorAll('li, [role="listitem"]');
    const clickableDivs = document.querySelectorAll('div[onclick], div[role="button"], div[tabindex]');
    const sessionElements = document.querySelectorAll('[class*="session"], [data-testid*="session"], [id*="session"]');
    
    return {
      tableCount: tables.length,
      rowCount: rows.length,
      listItemCount: listItems.length,
      clickableDivCount: clickableDivs.length,
      sessionElementCount: sessionElements.length,
      bodyClassList: document.body ? Array.from(document.body.classList) : [],
      title: document.title || 'No title'
    };
  });

  logger.info(`[HARVESTER] DOM Structure - Tables: ${domStats.tableCount}, Rows: ${domStats.rowCount}, List Items: ${domStats.listItemCount}, Clickable Divs: ${domStats.clickableDivCount}, Session Elements: ${domStats.sessionElementCount}`);
  logger.info(`[HARVESTER] Page Title: "${domStats.title}", Body Classes: [${domStats.bodyClassList.join(', ')}]`);

  const sessions = [];
  let scrollAttempts = 0;
  const maxScrolls = 20;

  while (sessions.length < maxSessions && scrollAttempts < maxScrolls) {
    // Zipy Session Replay uses MUI Table — select MuiTableRow elements (skip header row)
    const newSessions = await page.evaluate(() => {
      const results = [];

      // Primary: MUI Table rows (Zipy's session list is a MUI table at /user-sessions)
      const muiRows = document.querySelectorAll('[class*="MuiTableRow"], tr');
      // Filter to data rows only (skip header — header has th/MuiTableCell-head)
      const dataRows = [...muiRows].filter(row => {
        const cells = row.querySelectorAll('td, [class*="MuiTableCell-body"]');
        return cells.length >= 2; // Data rows have multiple td cells
      });

      const allElements = dataRows;
      
      // React state extraction fallback
      let reactData = null;
      try {
        // Try Next.js data
        if (window.__NEXT_DATA__) {
          reactData = window.__NEXT_DATA__;
        }
        // Try generic React data
        else if (window.__data__) {
          reactData = window.__data__;
        }
        // Try app state
        else if (window.__APP_STATE__) {
          reactData = window.__APP_STATE__;
        }
        // Try Redux store
        else if (window.__REDUX_STORE__) {
          reactData = window.__REDUX_STORE__.getState();
        }
      } catch (e) {
        // React state extraction failed silently
      }

      for (const element of allElements) {
        // Zipy table columns: USER (name + agent code) | SESSION TIME | LATEST | ENVIRONMENT
        const cells = element.querySelectorAll('td, [class*="MuiTableCell-body"]');
        const sessionLink = element.querySelector('a[href*="session"], a[href*="user-session"]');
        const sessionUrl = sessionLink?.href || '';
        const sessionId = sessionUrl.match(/session[s]?\/([a-zA-Z0-9_-]+)/)?.[1] ||
                          element.getAttribute('data-session-id') ||
                          `row-${results.length}`;

        // Extract metadata from visible text
        const text = element.textContent || '';

        // Duration - look for time patterns like "2m 30s", "1:30", "00:02:30"
        const durationMatch = text.match(/(\d+)\s*m\s*(\d+)\s*s/) ||
          text.match(/(\d+):(\d+):(\d+)/) ||
          text.match(/(\d+):(\d+)/);
        let duration = 0;
        if (durationMatch) {
          if (durationMatch.length === 3 && text.includes('m')) {
            duration = parseInt(durationMatch[1]) * 60 + parseInt(durationMatch[2]);
          } else if (durationMatch.length === 4) {
            duration = parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseInt(durationMatch[3]);
          } else {
            duration = parseInt(durationMatch[1]) * 60 + parseInt(durationMatch[2]);
          }
        }

        // Page count
        const pageMatch = text.match(/(\d+)\s*page/i);
        const pageCount = pageMatch ? parseInt(pageMatch[1]) : 0;

        // Error count
        const errorBadge = element.querySelector('[class*="error"], [class*="Error"], .badge-error');
        const errorMatch = text.match(/(\d+)\s*error/i);
        const errorCount = errorMatch ? parseInt(errorMatch[1]) : (errorBadge ? 1 : 0);

        // Rage clicks
        const hasRageClicks = text.toLowerCase().includes('rage') ||
          !!element.querySelector('[class*="rage"]');

        // Device type
        const deviceEl = element.querySelector('[class*="device"], [class*="Device"]');
        const deviceText = (deviceEl?.textContent || text).toLowerCase();
        let deviceType = 'unknown';
        if (deviceText.includes('mobile') || deviceText.includes('phone')) deviceType = 'mobile';
        else if (deviceText.includes('tablet') || deviceText.includes('ipad')) deviceType = 'tablet';
        else if (deviceText.includes('desktop') || deviceText.includes('windows') || deviceText.includes('mac')) deviceType = 'desktop';

        // Last page
        const pageEls = element.querySelectorAll('[class*="page"], [class*="url"]');
        const lastPage = pageEls.length > 0 ? pageEls[pageEls.length - 1].textContent?.trim() : '';

        // Timestamp
        const timeEl = element.querySelector('[class*="time"], [class*="date"], time');
        const startTime = timeEl?.textContent?.trim() || timeEl?.getAttribute('datetime') || '';

        // User identifier — Zipy shows "User13206" + "IN-LUG002863" in first cell
        const userEl = element.querySelector('[class*="user"], [class*="identifier"], [class*="email"]');
        const firstCellText = cells.length > 0 ? cells[0].textContent?.trim() : '';
        const userIdentifier = userEl?.textContent?.trim() || firstCellText || '';

        // Extract agent code (format: IN-XXX######)
        const agentCodeMatch = text.match(/IN-[A-Z]{3}\d{6}/);
        const agentCode = agentCodeMatch ? agentCodeMatch[0] : '';

        // Timestamp from "LATEST" column — e.g. "Apr 13, 9:39 pm"
        const latestMatch = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+,\s*\d+:\d+\s*(am|pm)/i);
        if (latestMatch && !startTime) {
          // Use matched timestamp
        }

        // Location from "ENVIRONMENT" column — e.g. "New Delhi, In..."
        const locationMatch = text.match(/(?:New Delhi|Mumbai|Kanpur|Bhubaneswa|Rajkot|Chennai|Ahmedabad|Bangalore|Kolkata|Hyderabad|Pune|Jaipur|Lucknow|Patna|Indore|Bhopal|Vadodara|Goa|Surat|Nagpur|Chandigarh|Gurgaon|Noida|Delhi|India|[A-Z][a-z]+(?:,\s*[A-Z][a-z]+)?)/);
        const location = locationMatch ? locationMatch[0] : '';

        // Live status
        const isLive = text.toLowerCase().includes('live');

        // Accept any row that has cells (MUI table data rows)
        if (cells.length >= 2) {
          results.push({
            sessionId: sessionId || `session-${results.length}`,
            sessionUrl,
            duration,
            pageCount,
            errorCount,
            hasRageClicks,
            lastPage,
            deviceType,
            startTime: startTime || (latestMatch ? latestMatch[0] : ''),
            userIdentifier,
            agentCode,
            location,
            isLive,
            extractionMethod: cells.length >= 2 ? 'mui_table' : (sessionId ? 'url_extraction' : 'fallback')
          });
        }
      }

      // If no sessions found via DOM, try React state extraction
      if (results.length === 0 && reactData) {
        try {
          // Look for session data in React state
          const sessionsFromState = findSessionsInObject(reactData);
          results.push(...sessionsFromState);
        } catch (e) {
          // React state parsing failed
        }
      }

      // Helper function to recursively search for session data in React state
      function findSessionsInObject(obj, depth = 0) {
        if (depth > 5 || !obj || typeof obj !== 'object') return [];
        
        const sessions = [];
        for (const [key, value] of Object.entries(obj)) {
          if (key.toLowerCase().includes('session') && Array.isArray(value)) {
            for (const session of value) {
              if (session && typeof session === 'object' && session.id) {
                sessions.push({
                  sessionId: session.id,
                  sessionUrl: session.url || '',
                  duration: session.duration || 0,
                  pageCount: session.pageCount || 0,
                  errorCount: session.errorCount || 0,
                  hasRageClicks: !!session.hasRageClicks,
                  lastPage: session.lastPage || '',
                  deviceType: session.deviceType || 'unknown',
                  startTime: session.startTime || '',
                  userIdentifier: session.userIdentifier || '',
                  extractionMethod: 'react_state'
                });
              }
            }
          } else if (typeof value === 'object') {
            sessions.push(...findSessionsInObject(value, depth + 1));
          }
        }
        return sessions;
      }

      return results;
    });

    // Add new unique sessions
    const existingIds = new Set(sessions.map(s => s.sessionId));
    const newSessionsAdded = [];
    for (const session of newSessions) {
      if (!existingIds.has(session.sessionId) && sessions.length < maxSessions) {
        sessions.push(session);
        existingIds.add(session.sessionId);
        newSessionsAdded.push(session);
      }
    }

    logger.info(`[HARVESTER] Scroll ${scrollAttempts + 1}: Found ${newSessions.length} potential sessions, added ${newSessionsAdded.length} new unique sessions`);

    // Scroll down to load more
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(2000);
    scrollAttempts++;

    // Check if a "Load more" or "Next" button exists
    const loadMoreSelectors = [
      'button:has-text("Load More")', 'button:has-text("Show More")',
      'button:has-text("Next")', '.load-more-btn', '.pagination-next',
    ];

    for (const sel of loadMoreSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          await page.waitForTimeout(2000);
          logger.info(`[HARVESTER] Clicked load more button: ${sel}`);
          break;
        }
      } catch (error) {
        // Button click failed, continue
      }
    }
  }

  // Enhanced error reporting
  if (sessions.length === 0) {
    if (domStats.sessionElementCount === 0 && domStats.rowCount === 0) {
      throw new Error('HARVEST_ERROR: Selectors found 0 elements - DOM contains no recognizable session containers or table rows');
    } else if (domStats.sessionElementCount > 0 || domStats.rowCount > 0) {
      throw new Error('HARVEST_ERROR: State extraction failed - Found session elements in DOM but could not extract session data');
    } else {
      throw new Error('HARVEST_ERROR: No sessions harvested despite scrolling and DOM analysis');
    }
  }

  logger.info(`[HARVESTER] Successfully harvested ${sessions.length} sessions`);
  logger.info(`[HARVESTER] Extraction methods used: ${[...new Set(sessions.map(s => s.extractionMethod))].join(', ')}`);
  
  return sessions;
}

module.exports = { harvest };