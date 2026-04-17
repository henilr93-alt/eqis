const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const MAX_HEIGHT = 4000; // Claude Vision max is 8000px, cap at 4000 for safety

async function takeStep(page, runId, stepName) {
  const dir = path.join(__dirname, '..', 'reports', 'journey', runId, 'screenshots');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filePath = path.join(dir, `${stepName}.png`);

  try {
    // Take viewport screenshot (not fullPage) to avoid oversized images
    // If the page is very tall, fullPage screenshots can exceed 8000px
    const viewportSize = page.viewportSize();
    const useFullPage = viewportSize && viewportSize.height <= MAX_HEIGHT;

    let buffer;
    if (useFullPage) {
      // Try full page first but clip to max height
      buffer = await page.screenshot({
        fullPage: false,
        clip: { x: 0, y: 0, width: viewportSize.width || 1280, height: Math.min(MAX_HEIGHT, viewportSize.height || 800) },
      });
    } else {
      // Just capture the visible viewport
      buffer = await page.screenshot({ fullPage: false });
    }

    fs.writeFileSync(filePath, buffer);
    const base64 = buffer.toString('base64');
    logger.info(`[SCREENSHOT] ${stepName} saved to ${filePath} (${Math.round(buffer.length / 1024)}KB)`);
    return base64;
  } catch (err) {
    // Fallback: viewport-only screenshot
    try {
      const buffer = await page.screenshot({ fullPage: false });
      fs.writeFileSync(filePath, buffer);
      const base64 = buffer.toString('base64');
      logger.info(`[SCREENSHOT] ${stepName} saved (fallback viewport) to ${filePath}`);
      return base64;
    } catch (err2) {
      logger.error(`[SCREENSHOT] Failed for ${stepName}: ${err2.message}`);
      return null;
    }
  }
}

module.exports = { takeStep };
