#!/usr/bin/env node
// One-shot ECD comparison runner — bypasses cron / preview server crashes.
require('../ecd-comparator/ecdOrchestrator').runEcdComparisonCycle({ force: true })
  .then((r) => {
    if (r.skipped) { console.log('SKIPPED: ' + r.reason); return; }
    console.log('\n===');
    console.log('RUN ID:', r.comparison.runId);
    console.log('Total comparison rows:', r.comparison.hotelComparisons.length);
    for (const row of r.comparison.hotelComparisons) {
      if (!row.hotelName) {
        console.log('  ' + row.destination + ' [' + row.ecdStatus + '] ' + (row.error || ''));
        continue;
      }
      const c = row.combos[0] || {};
      const ecdPrice = c.ecd && c.ecd.totalPrice;
      const normalPrice = c.normal && c.normal.totalPrice;
      const diff = c.diff || {};
      const verdict = c.verdict || row.topVerdict;
      console.log('  ' + row.destination + ' | ' + row.hotelName);
      console.log('     ECD: ' + (ecdPrice ? 'INR ' + ecdPrice : '-') +
        '  Normal: ' + (normalPrice ? 'INR ' + normalPrice : '-') +
        (diff.pct != null ? '  Diff: ' + (diff.pct > 0 ? '+' : '') + diff.pct + '%' : '') +
        '  -> ' + verdict);
    }
    console.log('\nSUMMARY:', JSON.stringify(r.comparison.summary, null, 2));
  })
  .catch((e) => { console.error('FAILED:', e.message); });
