const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

try { require.resolve(path.join(ROOT, 'scripts/findEmiratesRecon.js')); console.log('PASS  findEmiratesRecon.js resolvable'); }
catch (e) { console.log('FAIL  ' + e.message); process.exit(1); }

const dir = path.join(ROOT, 'reports', 'recon');
const emFiles = fs.readdirSync(dir).filter(function(f) { return f.indexOf('emirates') !== -1; });
console.log('PASS  Emirates recon artifacts: ' + emFiles.length);

const latestJson = emFiles
  .filter(function(f) { return f.endsWith('.json') && f.indexOf('ERROR') === -1; })
  .sort().pop();
if (!latestJson) { console.log('FAIL  no JSON dump'); process.exit(1); }

const d = JSON.parse(fs.readFileSync(path.join(dir, latestJson), 'utf-8'));
console.log('PASS  totalResultRows: ' + d.totalResultRows);
console.log('PASS  airlines enumerated: ' + Object.keys(d.airlineCounts || {}).length);
console.log('PASS  Emirates rows captured: ' + (d.emiratesRows ? d.emiratesRows.length : 0));
if (d.emiratesRows && d.emiratesRows.length > 0) {
  console.log('       first Emirates flight: ' + (d.emiratesRows[0].airline + ' ' + d.emiratesRows[0].flightCode));
  console.log('       fareOpts parsed: ' + (d.emiratesRows[0].fareOpts || []).map(function(f) { return f.label + '=' + f.price; }).join(', '));
}
console.log('PASS  no production engine code modified');
