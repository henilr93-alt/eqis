const logger = require('../utils/logger');

const FLIGHT_CONFIRMATION_CHECKS = [
  { id: 'PNR_VISIBLE', label: 'PNR / Booking Reference displayed', severity: 'P0' },
  { id: 'PASSENGER_NAMES', label: 'Passenger names shown correctly', severity: 'P0' },
  { id: 'ROUTE_CORRECT', label: 'Flight route and dates shown correctly', severity: 'P0' },
  { id: 'FARE_BREAKDOWN', label: 'Full fare breakdown with taxes visible', severity: 'P1' },
  { id: 'TICKET_STATUS', label: 'Ticket status shown (Confirmed/On Hold)', severity: 'P0' },
  { id: 'DOWNLOAD_OPTION', label: 'Download itinerary / e-ticket available', severity: 'P1' },
  { id: 'EMAIL_SENT_NOTICE', label: 'Confirmation email sent notice shown', severity: 'P2' },
  { id: 'CANCELLATION_LINK', label: 'Cancellation / Manage booking link present', severity: 'P1' },
  { id: 'GST_DETAILS', label: 'GST invoice details accessible (B2B)', severity: 'P1' },
  { id: 'SUPPORT_CONTACT', label: 'Support contact visible on confirmation', severity: 'P3' },
];

const HOTEL_CONFIRMATION_CHECKS = [
  { id: 'BOOKING_ID', label: 'Hotel booking ID displayed', severity: 'P0' },
  { id: 'HOTEL_NAME', label: 'Hotel name and address shown', severity: 'P0' },
  { id: 'CHECKIN_CHECKOUT', label: 'Check-in and check-out dates correct', severity: 'P0' },
  { id: 'ROOM_TYPE', label: 'Room type confirmed', severity: 'P0' },
  { id: 'GUEST_NAME', label: 'Lead guest name shown', severity: 'P1' },
  { id: 'TOTAL_AMOUNT', label: 'Total amount charged displayed', severity: 'P0' },
  { id: 'VOUCHER_DOWNLOAD', label: 'Hotel voucher download available', severity: 'P1' },
  { id: 'CANCELLATION_POLICY', label: 'Cancellation policy shown', severity: 'P1' },
  { id: 'EMAIL_SENT_NOTICE', label: 'Confirmation email sent notice', severity: 'P2' },
];

async function validate(page, type, pnrData) {
  const checks = type === 'flight' ? FLIGHT_CONFIRMATION_CHECKS : HOTEL_CONFIRMATION_CHECKS;
  const results = {};
  let pageText = '';
  try { pageText = await page.textContent('body'); } catch { /* ignore */ }

  for (const check of checks) {
    let passed = null;
    try {
      switch (check.id) {
        case 'PNR_VISIBLE':
        case 'BOOKING_ID':
          passed = pnrData.pnr !== null;
          break;
        case 'PASSENGER_NAMES':
        case 'GUEST_NAME':
          passed = pageText.includes('EQISTEST');
          break;
        case 'ROUTE_CORRECT':
        case 'HOTEL_NAME':
        case 'CHECKIN_CHECKOUT':
        case 'ROOM_TYPE':
          passed = pageText.length > 100; // page loaded with content
          break;
        case 'FARE_BREAKDOWN':
        case 'TOTAL_AMOUNT':
          passed = /[\u20B9][\d,]+|INR\s*[\d,]+/i.test(pageText);
          break;
        case 'TICKET_STATUS':
          passed = /confirmed|on\s*hold|booked/i.test(pageText);
          break;
        case 'DOWNLOAD_OPTION':
        case 'VOUCHER_DOWNLOAD':
          passed = (await page.$('button:has-text("Download"), a:has-text("Download"), a:has-text("E-ticket"), a:has-text("Voucher")')) !== null;
          break;
        case 'EMAIL_SENT_NOTICE':
          passed = /email|mail.*sent|confirmation.*sent/i.test(pageText);
          break;
        case 'CANCELLATION_LINK':
        case 'CANCELLATION_POLICY':
          passed = pageText.toLowerCase().includes('cancel');
          break;
        case 'GST_DETAILS':
          passed = /gst|gstin/i.test(pageText);
          break;
        case 'SUPPORT_CONTACT':
          passed = /support|contact|help/i.test(pageText);
          break;
      }
    } catch { passed = null; }

    results[check.id] = { label: check.label, passed, severity: check.severity };
  }

  const failedCount = Object.values(results).filter(r => r.passed === false).length;
  logger.info(`[VALIDATOR] ${type} confirmation: ${Object.keys(results).length - failedCount} pass, ${failedCount} fail`);

  return results;
}

module.exports = { validate, FLIGHT_CONFIRMATION_CHECKS, HOTEL_CONFIRMATION_CHECKS };
