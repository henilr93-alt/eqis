const fs = require('fs');
const path = require('path');

function readJsonSync(relPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf-8'));
  } catch { return null; }
}

function liveApi(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = () => {
    try {
      const state = readJsonSync('state/systemState.json');
      const signal = readJsonSync('state/searchQualitySignal.json');
      const payload = JSON.stringify({
        systemState: state,
        searchHealth: signal?.overallHealth || 'UNKNOWN',
        timestamp: new Date().toISOString(),
      });
      res.write(`data: ${payload}\n\n`);
    } catch { /* ignore */ }
  };

  send();
  const interval = setInterval(send, 5000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
}

module.exports = { liveApi };
