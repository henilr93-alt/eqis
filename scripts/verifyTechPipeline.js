const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

delete require.cache[require.resolve(path.join(ROOT, 'utils/emailTemplates'))];
delete require.cache[require.resolve(path.join(ROOT, 'utils/dailyDigestScheduler'))];

const sched = require(path.join(ROOT, 'utils/dailyDigestScheduler'));
const tpl   = require(path.join(ROOT, 'utils/emailTemplates'));

const roster = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/emailRoster.json'), 'utf-8'));
const tech = (roster.teams || []).find(t => t.id === 'tech');
console.log('Tech team recipients (' + (tech.emails || []).length + '):');
(tech.emails || []).forEach(e => console.log('  ' + e));

const data = sched._internals.gatherSpfData();
console.log('');
console.log('Pulled SearchPulse window (previous day):');
console.log('  total searches: ' + (data.totals && data.totals.totalSearches));
console.log('  etrav issues:   ' + (data.totals && data.totals.totalEtravIssues));
const sr = data.overallSuccessRate;
console.log('  success rate:   ' + ((sr === undefined || sr === null) ? 'n/a' : sr.toFixed(1) + '%'));

const out = tpl.renderTechDigest(data);
console.log('');
console.log('Subject: ' + out.subject);
console.log('Summary: ' + out.summaryLine);

const html = out.html;
const checks = [
  ['(yesterday)',                                'Subject parenthetical present'],
  ['Window: yesterday',                          'Window caption updated'],
  ['Slowest search per engine (yesterday)',      'Slowest header updated'],
  ['Etrav issues yesterday',                     'Hero label updated'],
];
console.log('');
console.log('Wording checks:');
checks.forEach(function(pair) {
  console.log('  ' + (html.indexOf(pair[0]) !== -1 ? 'PASS' : 'FAIL') + '  ' + pair[1]);
});
fs.writeFileSync('/tmp/eqis-tech-preview.html', html);
console.log('Saved: /tmp/eqis-tech-preview.html  (' + html.length + ' bytes)');
