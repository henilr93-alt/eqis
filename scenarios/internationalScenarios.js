const INTERNATIONAL_DEEP_SCENARIOS = [
  // Middle East
  { id: 'INTL-DEEP-ME-01', label: 'Intl OW Economy | BOM→DXB | 2A | IndiGo filter', type: 'international', tripType: 'one-way', from: 'BOM', fromCity: 'Mumbai', to: 'DXB', toCity: 'Dubai', cabinClass: 'Economy', passengers: { adults: 2, children: 0, infants: 0 }, dateOffsetDays: 21, filtersToApply: ['nonstop_only', 'airline_filter_indigo'], preferNonStop: true, deepFocus: true },
  { id: 'INTL-DEEP-ME-02', label: 'Intl OW Business | DEL→AUH | 1A | Emirates', type: 'international', tripType: 'one-way', from: 'DEL', fromCity: 'Delhi', to: 'AUH', toCity: 'Abu Dhabi', cabinClass: 'Business', passengers: { adults: 1, children: 0, infants: 0 }, dateOffsetDays: 30, filtersToApply: ['business_only'], preferNonStop: false, deepFocus: true },
  { id: 'INTL-DEEP-ME-03', label: 'Intl OW Economy | HYD→KWI | 3A | Low fare', type: 'international', tripType: 'one-way', from: 'HYD', fromCity: 'Hyderabad', to: 'KWI', toCity: 'Kuwait', cabinClass: 'Economy', passengers: { adults: 3, children: 0, infants: 0 }, dateOffsetDays: 14, filtersToApply: ['sort_by_price'], preferNonStop: false, deepFocus: true },
  { id: 'INTL-DEEP-ME-04', label: 'Intl OW Economy | COK→DXB | 4A | Kerala-Gulf', type: 'international', tripType: 'one-way', from: 'COK', fromCity: 'Kochi', to: 'DXB', toCity: 'Dubai', cabinClass: 'Economy', passengers: { adults: 4, children: 0, infants: 0 }, dateOffsetDays: 10, filtersToApply: ['sort_by_price', 'nonstop_only'], preferNonStop: true, deepFocus: true },

  // Southeast Asia
  { id: 'INTL-DEEP-SEA-01', label: 'Intl OW Economy | BOM→SIN | 2A 1C | 1 stop', type: 'international', tripType: 'one-way', from: 'BOM', fromCity: 'Mumbai', to: 'SIN', toCity: 'Singapore', cabinClass: 'Economy', passengers: { adults: 2, children: 1, infants: 0 }, dateOffsetDays: 25, filtersToApply: ['sort_by_price'], preferNonStop: false, deepFocus: true },
  { id: 'INTL-DEEP-SEA-02', label: 'Intl OW Economy | DEL→BKK | 2A | Thai filter', type: 'international', tripType: 'one-way', from: 'DEL', fromCity: 'Delhi', to: 'BKK', toCity: 'Bangkok', cabinClass: 'Economy', passengers: { adults: 2, children: 0, infants: 0 }, dateOffsetDays: 18, filtersToApply: ['sort_by_price'], preferNonStop: false, deepFocus: true },
  { id: 'INTL-DEEP-SEA-03', label: 'Intl OW Economy | BLR→KUL | 5A | Group', type: 'international', tripType: 'one-way', from: 'BLR', fromCity: 'Bangalore', to: 'KUL', toCity: 'Kuala Lumpur', cabinClass: 'Economy', passengers: { adults: 5, children: 0, infants: 0 }, dateOffsetDays: 20, filtersToApply: ['sort_by_price'], preferNonStop: false, deepFocus: true },
  { id: 'INTL-DEEP-SEA-04', label: 'Intl OW Economy | MAA→DPS | 2A | Bali', type: 'international', tripType: 'one-way', from: 'MAA', fromCity: 'Chennai', to: 'DPS', toCity: 'Bali', cabinClass: 'Economy', passengers: { adults: 2, children: 0, infants: 0 }, dateOffsetDays: 30, filtersToApply: ['sort_by_price'], preferNonStop: false, deepFocus: true },

  // Europe
  { id: 'INTL-DEEP-EU-01', label: 'Intl OW Economy | BOM→LHR | 2A | Air India', type: 'international', tripType: 'one-way', from: 'BOM', fromCity: 'Mumbai', to: 'LHR', toCity: 'London', cabinClass: 'Economy', passengers: { adults: 2, children: 0, infants: 0 }, dateOffsetDays: 45, filtersToApply: ['sort_by_price'], preferNonStop: false, deepFocus: true },
  { id: 'INTL-DEEP-EU-02', label: 'Intl OW Business | DEL→CDG | 1A | Paris', type: 'international', tripType: 'one-way', from: 'DEL', fromCity: 'Delhi', to: 'CDG', toCity: 'Paris', cabinClass: 'Business', passengers: { adults: 1, children: 0, infants: 0 }, dateOffsetDays: 60, filtersToApply: ['business_only'], preferNonStop: false, deepFocus: true },

  // Long Haul
  { id: 'INTL-DEEP-LH-01', label: 'Intl OW Economy | BOM→SYD | 2A | Australia', type: 'international', tripType: 'one-way', from: 'BOM', fromCity: 'Mumbai', to: 'SYD', toCity: 'Sydney', cabinClass: 'Economy', passengers: { adults: 2, children: 0, infants: 0 }, dateOffsetDays: 45, filtersToApply: ['sort_by_price'], preferNonStop: false, deepFocus: true },
  { id: 'INTL-DEEP-LH-02', label: 'Intl OW Economy | DEL→YYZ | 2A | Canada', type: 'international', tripType: 'one-way', from: 'DEL', fromCity: 'Delhi', to: 'YYZ', toCity: 'Toronto', cabinClass: 'Economy', passengers: { adults: 2, children: 0, infants: 0 }, dateOffsetDays: 50, filtersToApply: ['sort_by_price'], preferNonStop: false, deepFocus: true },
];

const INTERNATIONAL_WEIGHT_BOOST = 1.5;

module.exports = { INTERNATIONAL_DEEP_SCENARIOS, INTERNATIONAL_WEIGHT_BOOST };
