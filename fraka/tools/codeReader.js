// Safe read-only view into the EQIS codebase for FRAKA.
// Also exports write helpers with strong path guards — used ONLY by the
// proposal executor in frakaApi, never by FRAKA directly.
//
// SAFETY RULES (enforced by every function here):
//   - Root is the EQIS project directory.
//   - Paths must resolve INSIDE the project (no .. escapes).
//   - Blocklist: .env, .git, node_modules, state/fraka/chats, state/fraka/proposals.json,
//                state/fraka/developments.json, state/fraka/painPoints.json, logs/,
//                reports/, backups, anything containing "password" or "secret".
//   - Max file size: 500KB to prevent abuse.
//   - Writes automatically create a timestamped backup under state/fraka/code-backups/.

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'state', 'fraka', 'code-backups');
const MAX_FILE_BYTES = 500 * 1024;

// Directories + files that must NEVER be read or written by FRAKA.
const BLOCKLIST_PATTERNS = [
  /^\.env/,
  /^\.git(\/|$)/,
  /^node_modules(\/|$)/,
  /^state\/fraka\/chats(\/|$)/,
  /^state\/fraka\/proposals\.json$/,
  /^state\/fraka\/developments\.json$/,
  /^state\/fraka\/painPoints\.json$/,
  /^state\/fraka\/techFeedback\.json$/,
  /^state\/fraka\/frakaState\.json$/,
  /^state\/fraka\/code-backups(\/|$)/,
  /^logs(\/|$)/,
  /^reports(\/|$)/,
  /\.log$/,
  /secret/i,
  /password/i,
  /credential/i,
  /private.*key/i,
];

// File extensions FRAKA is allowed to read/write (keeps it to code + config).
const ALLOWED_EXTENSIONS = [
  '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.html', '.css',
  '.svg', '.yml', '.yaml', '.sh', '.ts',
];

function normalizeRelative(p) {
  if (typeof p !== 'string') throw new Error('path must be a string');
  // Strip leading slashes; never allow absolute paths from callers
  let rel = p.replace(/^\/+/, '').replace(/\\/g, '/');
  // Normalize and flatten ../
  const abs = path.resolve(PROJECT_ROOT, rel);
  if (!abs.startsWith(PROJECT_ROOT + path.sep) && abs !== PROJECT_ROOT) {
    throw new Error(`Path escapes project root: ${p}`);
  }
  return path.relative(PROJECT_ROOT, abs).replace(/\\/g, '/');
}

function isPathAllowed(relPath) {
  const rel = relPath.replace(/\\/g, '/');
  for (const pat of BLOCKLIST_PATTERNS) {
    if (pat.test(rel)) return false;
  }
  return true;
}

function isExtensionAllowed(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (!ext) return true; // allow extension-less files like Dockerfile, Makefile
  return ALLOWED_EXTENSIONS.includes(ext);
}

function guard(relPath) {
  const rel = normalizeRelative(relPath);
  if (!isPathAllowed(rel)) {
    throw new Error(`Path is blocklisted: ${rel}`);
  }
  if (!isExtensionAllowed(rel)) {
    throw new Error(`File extension not allowed: ${rel}`);
  }
  return rel;
}

/**
 * Read a text file from the project. Returns { relPath, content, size, lines }.
 */
function readProjectFile(relPath) {
  const rel = guard(relPath);
  const abs = path.join(PROJECT_ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${rel}`);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${rel}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File too large (${stat.size} bytes > ${MAX_FILE_BYTES})`);
  }
  const content = fs.readFileSync(abs, 'utf-8');
  return {
    relPath: rel,
    content,
    size: stat.size,
    lines: content.split('\n').length,
    modifiedAt: stat.mtime.toISOString(),
  };
}

/**
 * List entries directly inside a project subdirectory.
 * Returns array of {name, relPath, type: 'file'|'dir', size?}.
 */
function listProjectDir(relDir = '') {
  const rel = relDir ? normalizeRelative(relDir) : '';
  if (rel && !isPathAllowed(rel)) throw new Error(`Path is blocklisted: ${rel}`);
  const abs = rel ? path.join(PROJECT_ROOT, rel) : PROJECT_ROOT;
  if (!fs.existsSync(abs)) throw new Error(`Directory not found: ${rel}`);
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${rel}`);

  return fs.readdirSync(abs)
    .filter(name => !name.startsWith('.'))
    .map(name => {
      const childRel = rel ? `${rel}/${name}` : name;
      if (!isPathAllowed(childRel)) return null;
      const childAbs = path.join(abs, name);
      let childStat;
      try { childStat = fs.statSync(childAbs); } catch { return null; }
      return {
        name,
        relPath: childRel,
        type: childStat.isDirectory() ? 'dir' : 'file',
        size: childStat.isFile() ? childStat.size : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * Build a compact project tree string to inject into FRAKA's chat context.
 * Only includes directories FRAKA actually cares about.
 */
function buildProjectTree({ maxDepth = 3 } = {}) {
  const lines = [];
  function walk(absDir, relDir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(absDir); } catch { return; }
    entries
      .filter(name => !name.startsWith('.'))
      .sort()
      .forEach(name => {
        const childRel = relDir ? `${relDir}/${name}` : name;
        if (!isPathAllowed(childRel)) return;
        const childAbs = path.join(absDir, name);
        let stat;
        try { stat = fs.statSync(childAbs); } catch { return; }
        const indent = '  '.repeat(depth);
        if (stat.isDirectory()) {
          lines.push(`${indent}${name}/`);
          walk(childAbs, childRel, depth + 1);
        } else if (isExtensionAllowed(childRel) && stat.size <= MAX_FILE_BYTES) {
          lines.push(`${indent}${name} (${stat.size}b)`);
        }
      });
  }
  walk(PROJECT_ROOT, '', 0);
  return lines.join('\n');
}

/**
 * Search for a substring across allowed files. Returns [{relPath, matchCount, firstLine}].
 */
function searchCode(query, { limit = 25 } = {}) {
  if (!query || query.length < 2) return [];
  const hits = [];
  function walk(absDir, relDir) {
    let entries;
    try { entries = fs.readdirSync(absDir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const childRel = relDir ? `${relDir}/${name}` : name;
      if (!isPathAllowed(childRel)) continue;
      const childAbs = path.join(absDir, name);
      let stat;
      try { stat = fs.statSync(childAbs); } catch { continue; }
      if (stat.isDirectory()) {
        walk(childAbs, childRel);
      } else if (isExtensionAllowed(childRel) && stat.size <= MAX_FILE_BYTES) {
        try {
          const content = fs.readFileSync(childAbs, 'utf-8');
          const count = (content.match(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
          if (count > 0) {
            const firstLineIdx = content.toLowerCase().split('\n').findIndex(l => l.includes(query.toLowerCase()));
            const firstLine = firstLineIdx >= 0 ? content.split('\n')[firstLineIdx].trim().slice(0, 120) : '';
            hits.push({ relPath: childRel, matchCount: count, firstLine });
            if (hits.length >= limit) return;
          }
        } catch { /* skip unreadable */ }
      }
    }
  }
  walk(PROJECT_ROOT, '');
  return hits.sort((a, b) => b.matchCount - a.matchCount).slice(0, limit);
}

// ── Write helpers (ONLY called by the proposal executor) ───────────────────
function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function backupFile(rel) {
  ensureBackupDir();
  const abs = path.join(PROJECT_ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = rel.replace(/[\/\\]/g, '__');
  const backupPath = path.join(BACKUP_DIR, `${timestamp}__${safeName}.bak`);
  fs.copyFileSync(abs, backupPath);
  logger.info(`[FRAKA-CODE] Backed up ${rel} → ${path.basename(backupPath)}`);
  return backupPath;
}

/**
 * Safely write a file with backup. Called by proposal executor after approval.
 * @param {string} relPath
 * @param {string} content
 * @param {string} operation - 'create' | 'update' | 'delete'
 */
function writeProjectFile(relPath, content, operation = 'update') {
  const rel = guard(relPath);
  const abs = path.join(PROJECT_ROOT, rel);

  if (operation === 'delete') {
    if (!fs.existsSync(abs)) {
      return { status: 'noop', message: `File does not exist: ${rel}` };
    }
    const backup = backupFile(rel);
    fs.unlinkSync(abs);
    logger.info(`[FRAKA-CODE] Deleted ${rel}`);
    return { status: 'deleted', relPath: rel, backup: backup ? path.basename(backup) : null };
  }

  if (typeof content !== 'string') {
    throw new Error('content is required for create/update');
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
    throw new Error(`New content too large (> ${MAX_FILE_BYTES} bytes)`);
  }

  const existed = fs.existsSync(abs);
  if (operation === 'create' && existed) {
    throw new Error(`File already exists (use operation=update): ${rel}`);
  }
  if (operation === 'update' && !existed) {
    throw new Error(`File does not exist (use operation=create): ${rel}`);
  }

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  // Backup the existing file before overwriting
  let backup = null;
  if (existed) backup = backupFile(rel);

  fs.writeFileSync(abs, content, 'utf-8');
  logger.info(`[FRAKA-CODE] ${existed ? 'Updated' : 'Created'} ${rel} (${Buffer.byteLength(content, 'utf-8')} bytes)`);

  return {
    status: existed ? 'updated' : 'created',
    relPath: rel,
    bytes: Buffer.byteLength(content, 'utf-8'),
    backup: backup ? path.basename(backup) : null,
  };
}

module.exports = {
  PROJECT_ROOT,
  isPathAllowed,
  guard,
  readProjectFile,
  listProjectDir,
  buildProjectTree,
  searchCode,
  writeProjectFile,
  backupFile,
};
