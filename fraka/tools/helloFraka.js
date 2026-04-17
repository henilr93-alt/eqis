/**
 * FRAKA Hello Tool
 * Simple utility that confirms FRAKA is operational
 */

const logger = require('../../utils/logger');

/**
 * Returns a simple status message confirming FRAKA is online
 * @returns {string} Status message
 */
function sayHello() {
  const message = 'FRAKA is online and building';
  logger.log('FRAKA Hello Tool called');
  return message;
}

module.exports = {
  sayHello
};
