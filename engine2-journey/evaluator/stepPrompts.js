const STEP_CONTEXTS = {
  login: 'Login page. Agent credential fields, logo, layout.',
  flightSearch:
    'Flight search form. Verify: origin/destination fields, date picker, passenger selector, cabin class, search button.',
  flightResults:
    'Search results page. Verify: result cards load, prices show, airline logos, filter panel, sort options, fare breakdowns.',
  flightFilters:
    'Filters applied to results. Verify: filters work correctly, results update, filter badges show active state.',
  flightSelection:
    'Flight selected. Verify: fare selection UI, seat map if present, fare rules link.',
  flightAddons:
    'Add-ons page (seats/meals/baggage). Verify: available options, selection UI, price updates.',
  passengerForm:
    'Passenger details form. Verify: all fields present, validation, mandatory field markers, GST field for B2B.',
  reviewPage:
    'Booking review/summary page. Verify: all details correct, price breakdown, fare rules, edit options.',
  paymentPage:
    'PAYMENT PAGE — test STOPS here. Evaluate: payment options, security indicators, price summary, UPI/card/netbanking options.',
  hotelSearch:
    'Hotel search form. Verify: destination field, date picker, room/guest selector, search button.',
  hotelResults:
    'Hotel results listing. Verify: property cards, star ratings, prices, photos, filter panel.',
  hotelRoomSelect:
    'Hotel detail / room selection. Verify: room types, occupancy info, inclusion details, price per night, select button.',
  guestForm:
    'Hotel guest details form. Verify: guest name fields, contact info, special requests, GST.',
  hotelPayment:
    'HOTEL PAYMENT PAGE — test STOPS here. Evaluate: payment options, booking summary, cancellation policy visible.',
};

const INTERNATIONAL_EXTRA_CHECKS = `Additionally check for international-specific elements:
- Visa information or advisory per destination
- Transit visa requirements for connecting airports
- Passport validity requirement displayed
- Baggage allowance clearly shown
- Fare basis code visible
- GST/taxes breakdown visible
- Codeshare flights clearly labelled
- Operating vs marketing carrier distinction
- Fare rules / refund conditions link
- Multiple currency display if applicable`;

module.exports = { STEP_CONTEXTS, INTERNATIONAL_EXTRA_CHECKS };
