const ROUNDTRIP_SCENARIOS = [
  // Standard Domestic
  { id: 'RT-DOM-01', label: 'Domestic RT | BOM<>DEL | Economy | 2A | 5N', type: 'domestic', tripType: 'round-trip', rtType: 'standard', from: 'BOM', fromCity: 'Mumbai', to: 'DEL', toCity: 'Delhi', cabinClass: 'Economy', passengers: { adults: 2, children: 0, infants: 0 }, dateOffsetDays: 10, returnOffsetDays: 15, filtersToApply: ['sort_by_price'], preferNonStop: true, roundtripChecks: ['both_legs_visible', 'combined_fare_shown', 'return_date_correct'] },
  { id: 'RT-DOM-02', label: 'Domestic RT | DEL<>BLR | Business | 1A | Weekend', type: 'domestic', tripType: 'round-trip', rtType: 'standard', from: 'DEL', fromCity: 'Delhi', to: 'BLR', toCity: 'Bangalore', cabinClass: 'Business', passengers: { adults: 1, children: 0, infants: 0 }, dateOffsetDays: 5, returnOffsetDays: 7, filtersToApply: ['business_only'], preferNonStop: true, roundtripChecks: ['both_legs_visible', 'fare_breakdown_per_leg'] },

  // Standard International
  { id: 'RT-INTL-01', label: 'Intl RT | BOM<>DXB | Economy | 2A | 7N', type: 'international', tripType: 'round-trip', rtType: 'standard', from: 'BOM', fromCity: 'Mumbai', to: 'DXB', toCity: 'Dubai', cabinClass: 'Economy', passengers: { adults: 2, children: 0, infants: 0 }, dateOffsetDays: 21, returnOffsetDays: 28, filtersToApply: ['sort_by_price', 'nonstop_only'], preferNonStop: true, roundtripChecks: ['both_legs_visible', 'combined_fare_shown', 'return_airline_matches'], deepFocus: true },
  { id: 'RT-INTL-02', label: 'Intl RT | DEL<>SIN | Economy | 1A 1C | 10N', type: 'international', tripType: 'round-trip', rtType: 'standard', from: 'DEL', fromCity: 'Delhi', to: 'SIN', toCity: 'Singapore', cabinClass: 'Economy', passengers: { adults: 1, children: 1, infants: 0 }, dateOffsetDays: 30, returnOffsetDays: 40, filtersToApply: ['sort_by_price'], preferNonStop: false, roundtripChecks: ['both_legs_visible', 'child_fare_shown_separately'], deepFocus: true },
  { id: 'RT-INTL-03', label: 'Intl RT | BOM<>LHR | Business | 2A | 14N', type: 'international', tripType: 'round-trip', rtType: 'standard', from: 'BOM', fromCity: 'Mumbai', to: 'LHR', toCity: 'London', cabinClass: 'Business', passengers: { adults: 2, children: 0, infants: 0 }, dateOffsetDays: 45, returnOffsetDays: 59, filtersToApply: ['business_only'], preferNonStop: false, roundtripChecks: ['both_legs_visible', 'fare_breakdown_per_leg'], deepFocus: true },

  // Mixed Class
  { id: 'RT-MIXED-01', label: 'Mixed RT | DEL<>DXB | Eco out / Biz return | 1A', type: 'international', tripType: 'round-trip', rtType: 'mixed_class', from: 'DEL', fromCity: 'Delhi', to: 'DXB', toCity: 'Dubai', outboundClass: 'Economy', returnClass: 'Business', cabinClass: 'Economy', passengers: { adults: 1, children: 0, infants: 0 }, dateOffsetDays: 20, returnOffsetDays: 27, filtersToApply: [], mixedClassTest: true, roundtripChecks: ['mixed_class_supported', 'separate_class_per_leg'], deepFocus: true },

  // Open-Jaw
  { id: 'RT-OJ-01', label: 'Open-Jaw | BOM->DXB / AUH->BOM | Economy | 2A', type: 'international', tripType: 'open-jaw', rtType: 'open_jaw', from: 'BOM', fromCity: 'Mumbai', to: 'DXB', toCity: 'Dubai', returnFrom: 'AUH', returnFromCity: 'Abu Dhabi', returnTo: 'BOM', returnToCity: 'Mumbai', cabinClass: 'Economy', passengers: { adults: 2, children: 0, infants: 0 }, dateOffsetDays: 20, returnOffsetDays: 27, filtersToApply: ['sort_by_price'], openJawTest: true, roundtripChecks: ['open_jaw_form_available', 'different_return_origin_accepted'], deepFocus: true },

  // Short Turnaround
  { id: 'RT-SHORT-01', label: 'Short RT | BOM<>GOI | Economy | 2A | 1N', type: 'domestic', tripType: 'round-trip', rtType: 'short_turnaround', from: 'BOM', fromCity: 'Mumbai', to: 'GOI', toCity: 'Goa', cabinClass: 'Economy', passengers: { adults: 2, children: 0, infants: 0 }, dateOffsetDays: 3, returnOffsetDays: 4, filtersToApply: ['nonstop_only', 'sort_by_price'], preferNonStop: true, roundtripChecks: ['return_date_1_night_apart'] },
  { id: 'RT-SHORT-02', label: 'Short RT | DEL<>BOM | Economy | 1A | Day trip', type: 'domestic', tripType: 'round-trip', rtType: 'day_return', from: 'DEL', fromCity: 'Delhi', to: 'BOM', toCity: 'Mumbai', cabinClass: 'Economy', passengers: { adults: 1, children: 0, infants: 0 }, dateOffsetDays: 5, returnOffsetDays: 5, filtersToApply: ['morning_flights'], preferNonStop: true, roundtripChecks: ['same_day_return_accepted'] },
];

const ROUNDTRIP_WEIGHT_BOOST = 1.6;

module.exports = { ROUNDTRIP_SCENARIOS, ROUNDTRIP_WEIGHT_BOOST };
