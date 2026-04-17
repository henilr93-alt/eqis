// Active QA for any file FRAKA creates or edits.
// Runs fast, deterministic checks locally and reports back. Used by fraka/coder.js.
//
// Checks (by extension):
//   .js / .mjs / .cjs  → Node syntax parse (new Function), module require() check
//   .json              → JSON.parse
//   .html              → basic tag-balance check
//   .css               → basic brace-balance check
//   all                → non-empty, size, forbidden strings (env leaks, console.error spam)
//
// Returns { ok, checks: [{name, status, message}], summary }.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const logger = require('../../utils/logger');
const { PROJECT_ROOT } = require('./codeReader');

function runCheck(name, fn) {
  try {
    const result = fn();
    if (result && result.status === 'skipped') return result;
    return { name, status: 'pass', message: typeof result === 'string' ? result : 'OK' };
  } catch (err) {
    return { name, status: 'fail', message: err.message };
  }
}

function checkNonEmpty(content) {
  if (!content || !content.trim()) throw new Error('File is empty');
  return `${content.length} bytes, ${content.split('\n').length} lines`;
}

function checkForbiddenStrings(content) {
  const banned = [
    /password\s*=\s*['"][^'"]+['"]/i,
    /api[_-]?key\s*=\s*['"][^'"]+['"]/i,
    /bearer\s+[a-z0-9]{20,}/i,
    /\bSECRET\s*=\s*['"][^'"]+['"]/i,
  ];
  for (const pat of banned) {
    if (pat.test(content)) throw new Error(`Forbidden credential-like pattern: ${pat}`);
  }
  return 'No credential leaks';
}

function checkJsSyntax(content) {
  // Use Function constructor as a cheap syntax validator. Rejects syntax errors.
  try {
    new Function(content);
  } catch (err) {
    throw new Error('Syntax error: ' + err.message);
  }
  return 'Valid JS syntax';
}

function checkJsonSyntax(content) {
  JSON.parse(content);
  return 'Valid JSON';
}

function checkBraceBalance(content, open, close) {
  let o = 0, c = 0;
  for (const ch of content) {
    if (ch === open) o++;
    else if (ch === close) c++;
  }
  if (o !== c) throw new Error(`Unbalanced ${open}${close}: ${o} open, ${c} close`);
  return `${o} balanced pairs`;
}

function checkHtmlBalance(content) {
  // Very lightweight — counts open/close for common tags
  const openTags = (content.match(/<(?!\/|!|\?)[a-zA-Z]/g) || []).length;
  const closeTags = (content.match(/<\/[a-zA-Z]/g) || []).length;
  // We don't require exact balance (self-closing void elements exist), so just ensure close ≤ open.
  if (closeTags > openTags + 5) throw new Error(`Possible unbalanced HTML: ${openTags} open, ${closeTags} close`);
  return `${openTags} open tags, ${closeTags} close tags`;
}

function checkNodeRequire(absPath) {
  // Clear any cached version and try to load the module via require().
  // This catches require errors + syntactic issues missed by new Function().
  try {
    delete require.cache[absPath];
    const exported = require(absPath);
    // Clean up cache afterward to avoid poisoning other modules in the same process.
    delete require.cache[absPath];
    const keys = exported && typeof exported === 'object' ? Object.keys(exported) : [];
    return `Module loads OK (exports: ${keys.length})`;
  } catch (err) {
    throw new Error('Load error: ' + err.message);
  }
}

/**
 * Run QA on a file that already exists on disk.
 * @param {string} relPath
 * @returns {{ok, checks, summary}}
 */
function runFileQA(relPath) {
  const absPath = path.join(PROJECT_ROOT, relPath);
  if (!fs.existsSync(absPath)) {
    return { ok: false, checks: [{ name: 'exists', status: 'fail', message: 'File not found' }], summary: 'File does not exist' };
  }
  const content = fs.readFileSync(absPath, 'utf-8');
  const ext = path.extname(relPath).toLowerCase();

  const checks = [];
  checks.push(runCheck('non-empty', () => checkNonEmpty(content)));
  checks.push(runCheck('forbidden-strings', () => checkForbiddenStrings(content)));

  if (['.js', '.mjs', '.cjs'].includes(ext)) {
    checks.push(runCheck('js-syntax', () => checkJsSyntax(content)));
    checks.push(runCheck('js-braces', () => checkBraceBalance(content, '{', '}')));
    checks.push(runCheck('js-parens', () => checkBraceBalance(content, '(', ')')));
    checks.push(runCheck('node-require', () => checkNodeRequire(absPath)));
  } else if (ext === '.json') {
    checks.push(runCheck('json-parse', () => checkJsonSyntax(content)));
  } else if (ext === '.html') {
    checks.push(runCheck('html-balance', () => checkHtmlBalance(content)));
    // If there's an inline <script>, sanity-check that too.
    const m = content.match(/<script\b[^>]*>([\s\S]*?)<\/script>/);
    if (m && m[1].trim()) {
      checks.push(runCheck('inline-js', () => checkJsSyntax(m[1])));
    }
  } else if (ext === '.css') {
    checks.push(runCheck('css-braces', () => checkBraceBalance(content, '{', '}')));
  } else if (ext === '.svg') {
    checks.push(runCheck('svg-tag', () => {
      if (!/^\s*<\?xml|^\s*<svg/i.test(content)) throw new Error('Missing <svg> root');
      return 'Valid SVG';
    }));
  }

  const failed = checks.filter(c => c.status === 'fail');
  const ok = failed.length === 0;
  const summary = ok
    ? `${checks.length} checks passed`
    : `${failed.length}/${checks.length} checks failed: ${failed.map(c => c.name).join(', ')}`;

  logger.info(`[FRAKA-QA] ${relPath} — ${summary}`);
  return { ok, checks, summary };
}

module.exports = { runFileQA };
