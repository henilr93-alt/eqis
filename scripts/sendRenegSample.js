// One-off: send a Renegotiate-digest sample to director@etrav.in from a
// recent ECD report that actually has NORMAL_CHEAPER combos.
require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const tpl = require(path.join(ROOT, 'utils/emailTemplates'));
const mailer = require(path.join(ROOT, 'utils/mailer'));
const emailHistory = require(path.join(ROOT, 'utils/emailHistory'));

(async () => {
  const reportPath = path.join(ROOT, 'reports/ecd/ECD-20260612-1500.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const hotels = report.hotelComparisons || [];
  let reneg = 0;
  hotels.forEach(h => (h.combos || []).forEach(c => { if (c.verdict === 'NORMAL_CHEAPER') reneg++; }));
  console.log('Source report:', path.basename(reportPath));
  console.log('Hotels:', hotels.length, ' Reneg combos:', reneg);

  const rendered = tpl.renderContractingDigest({ hotels, runId: report.runId, summary: report.summary });
  console.log('Subject:', rendered.subject);
  console.log('Hotels listed in email body:', rendered.recordCount);

  const recipients = (process.argv[2] || 'director@etrav.in').split(',').map(s => s.trim()).filter(Boolean);
  const res = await mailer.send({ to: recipients, subject: rendered.subject, html: rendered.html });
  console.log('Send status:', res.ok ? 'OK' : 'FAILED', res.dryRun ? '(DRY-RUN)' : '');
  console.log('Gmail msg id:', res.messageId);

  emailHistory.append({
    teamId: 'contracting', teamName: 'Eagle Crest Contracting Team', reportType: 'ecd_renegotiate_digest',
    status: res.ok ? (res.dryRun ? 'DRY_RUN' : 'OK') : 'FAILED',
    recipients: res.recipients, subject: rendered.subject, summaryLine: rendered.summaryLine,
    recordCount: rendered.recordCount, messageId: res.messageId, dryRun: Boolean(res.dryRun), error: res.error,
  });
})().catch(e => { console.error('Crashed:', e.message); process.exit(1); });
