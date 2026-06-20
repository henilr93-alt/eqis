const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

delete require.cache[require.resolve(path.join(ROOT, 'utils/emailTemplates'))];
delete require.cache[require.resolve(path.join(ROOT, 'utils/dailyDigestScheduler'))];

const sched = require(path.join(ROOT, 'utils/dailyDigestScheduler'));
const tpl   = require(path.join(ROOT, 'utils/emailTemplates'));
const data  = sched._internals.gatherSpfData();
const out   = tpl.renderTechDigest(data);
fs.writeFileSync('/tmp/eqis-tech-preview.html', out.html);

const html = out.html;
const checks = ['Flight Domestic', 'Flight International', 'Hotel Domestic', 'Hotel International'];
console.log('Engine-name captions present below pie charts:');
checks.forEach(function(name) {
  console.log('  ' + ((html.indexOf(name) !== -1) ? 'PASS' : 'FAIL') + '  ' + name);
});
const captionDivs = (html.match(/margin-top:6px;font-size:13px;font-weight:700/g) || []).length;
console.log('Caption div blocks: ' + captionDivs + ((captionDivs === 4) ? '  PASS' : '  FAIL'));
console.log('Saved /tmp/eqis-tech-preview.html (' + html.length + ' bytes)');
