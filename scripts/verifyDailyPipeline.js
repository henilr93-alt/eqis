const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const roster = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/emailRoster.json'), 'utf-8'));
console.log('--- Roster check ---');
['marketing', 'contracting'].forEach(id => {
  const t = (roster.teams || []).find(x => x.id === id);
  if (t === undefined) { console.log('  FAIL  ' + id + ' not in roster'); return; }
  const ok = t.enabled && Array.isArray(t.emails) && t.emails.length > 0 && Array.isArray(t.reports) && t.reports.length > 0;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  enabled=' + t.enabled +
    '  emails=' + (t.emails || []).join(', ') + '  reports=' + (t.reports || []).join(','));
});

console.log('');
const boot = fs.readFileSync(path.join(ROOT, 'eqis.js'), 'utf-8');
const wiredRequire = boot.includes('dailyDigestScheduler');
const callsRegister = /dailyDigestScheduler[\s\S]{0,80}\.register\(\)/.test(boot);
console.log('--- eqis.js boot wiring ---');
console.log('  ' + (wiredRequire ? 'PASS' : 'FAIL') + '  references dailyDigestScheduler at boot');
console.log('  ' + (callsRegister ? 'PASS' : 'FAIL') + '  calls dailyDigestScheduler.register() at boot');

console.log('');
const sched = fs.readFileSync(path.join(ROOT, 'utils/dailyDigestScheduler.js'), 'utf-8');
const cronMatch = sched.match(/const pattern = '([^']+)';/);
const tzMatch = sched.includes('timezone: settings.TIMEZONE');
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf-8');
const tzEnv = (env.match(/^TIMEZONE=(.*)$/m) || [])[1] || '(unset)';
console.log('--- Schedule check ---');
console.log('  ' + (cronMatch ? 'PASS' : 'FAIL') + '  cron pattern: ' + (cronMatch ? cronMatch[1] : 'NOT FOUND'));
console.log('  ' + (tzMatch ? 'PASS' : 'FAIL') + '  timezone passed to cron: ' + tzEnv);

console.log('');
// Confirm both report types are registered in REPORT_REGISTRY
const ddRegistered = ['ecd_promote_digest','ecd_renegotiate_digest'].every(r => sched.includes(r));
console.log('--- Report registry ---');
console.log('  ' + (ddRegistered ? 'PASS' : 'FAIL') + '  both report types registered');

console.log('');
// Mailer is LIVE
const mailer = require(path.join(ROOT, 'utils/mailer'));
console.log('--- Mailer status ---');
console.log('  ' + (mailer.isEnabled() ? 'PASS' : 'FAIL') + '  mailer.isEnabled()=' + mailer.isEnabled() + ' (LIVE means real Gmail sends)');
