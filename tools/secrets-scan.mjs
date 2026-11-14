/**
 * tools/secrets-scan.mjs
 *
 * Scans EVERY surface a secret could reach the outside world through:
 *
 *   1. the tree a commit would publish ("tracked plus not ignored"), which
 *      since F6-R4-02 INCLUDES the published `artifacts/` directory;
 *   2. every blob reachable from any ref in the git history — a secret that
 *      was once committed and later deleted is still in every clone, so the
 *      working tree alone was a blind spot (round-4 finding F6-R4-02).
 *
 * What it looks for:
 *
 *   - AWS access key ids (AKIA / ASIA) and AWS secret access keys
 *   - PEM / OpenSSH private key headers
 *   - `sk-`, `ghp_` and `xoxb-` credential prefixes
 *   - `apiKey = "..."` style assignments
 *   - a non-empty `apiKeys` value in a settings file (any historical version
 *     included — a settings file that was once committed with a real key is
 *     exactly the leak this scan exists to name)
 *
 * It NEVER prints a secret. A finding is reported as surface, file/commit,
 * line number and a redacted fingerprint (a salted SHA-256 prefix plus the
 * length).
 *
 * Exit code 0 = clean. Exit code 1 = at least one finding.
 *
 * The tree scan excludes what is never published: `node_modules`, `dist`,
 * `.git`, the local settings override and the portable toolchain. The
 * HISTORY scan excludes nothing by path — whatever was once committed was
 * once published — only blobs that are oversized or binary.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories that are never part of the published tree. */
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  '.toolchain',
  '.edugenesis-data',
  'coverage',
  '.cache',
]);

/** Files larger than this are not scanned (they are not source). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Patterns. Each one captures the candidate secret in group 1 when it has a
 * value; the fingerprint is computed from that capture.
 */
const PATTERNS = [
  {
    id: 'aws-access-key-id',
    expression: /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g,
    group: 0,
  },
  {
    id: 'aws-secret-access-key',
    expression: /aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*["']([^"']{20,})["']/gi,
    group: 1,
  },
  {
    id: 'private-key-header',
    expression: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g,
    group: 0,
  },
  {
    // The rule is named for the SHAPE it detects, not for a vendor: the
    // scanner must not name a provider, because a provider name outside
    // packages/onekey is itself a leak (the no-provider-leak gate).
    id: 'sk-prefixed-key',
    expression: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]{32,}/g,
    group: 0,
  },
  {
    id: 'github-token',
    expression: /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{36}/g,
    group: 0,
  },
  {
    id: 'slack-token',
    expression: /(?<![A-Za-z0-9_-])xoxb-[A-Za-z0-9-]{12,}/g,
    group: 0,
  },
  {
    id: 'api-key-assignment',
    expression: /api[_-]?key\s*[:=]\s*["']([^"']{12,})["']/gi,
    group: 1,
  },
  {
    id: 'api-secret-assignment',
    expression: /api[_-]?secret\s*[:=]\s*["']([^"']{12,})["']/gi,
    group: 1,
  },
  {
    id: 'api-token-assignment',
    expression: /api[_-]?token\s*[:=]\s*["']([^"']{12,})["']/gi,
    group: 1,
  },
];

/** Values that are obviously not real credentials. */
const PLACEHOLDER_PATTERN =
  /(process\.env|\benv\.[A-Z]|\$\{|\{\{|<[A-Za-z_]|^[A-Za-z_]*$|^[A-Za-z_]*\.[A-Za-z_]+$|redact|placeholder|example|changeme|change_me|dummy|your[_-]|your |sample|xxxx|test[_-]?key|fake|\*\*\*)/i;

/** True when the captured value is a placeholder rather than a real secret. */
function looksLikePlaceholder(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (PLACEHOLDER_PATTERN.test(trimmed)) return true;
  if (/^(.)\1+$/.test(trimmed)) return true;
  return false;
}

/** A redacted fingerprint: a salted SHA-256 prefix plus the length. */
function fingerprint(value) {
  const salt = 'edugenesis-os-secrets-scan';
  const digest = createHash('sha256').update(`${salt}:${value}`).digest('hex');
  return `sha256:${digest.slice(0, 12)} (${value.length} chars)`;
}

/** The list of files a commit would publish. */
function publishedFiles() {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const entries = output.toString('utf8').split('\0').filter((entry) => entry.length > 0);
    if (entries.length > 0) return entries;
  } catch {
    // Not a git repository (or git is unavailable) — fall through to a walk.
  }
  return walk(ROOT, ROOT);
}

/** A filesystem walk used when git cannot answer. */
function walk(directory, root) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      found.push(...walk(join(directory, entry.name), root));
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = relative(root, join(directory, entry.name)).split(sep).join('/');
    if (isExcluded(relativePath)) continue;
    found.push(relativePath);
  }
  return found;
}

/** True when the path must never be scanned. */
function isExcluded(relativePath) {
  const segments = relativePath.split('/');
  if (segments.some((segment) => SKIP_DIRECTORIES.has(segment))) return true;
  const name = segments[segments.length - 1] ?? '';
  // The local settings override is untracked by design: it is where a user's
  // own key lives. It is never published, so it is never scanned here.
  if (name.endsWith('.local.json')) return true;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (name.endsWith('.pem') || name.endsWith('.key')) return true;
  if (name.endsWith('.log')) return true;
  return false;
}

/** Find a non-empty apiKeys value in a settings file. */
function findApiKeyEntries(relativePath, text) {
  if (!relativePath.startsWith('settings/')) return [];
  if (!relativePath.endsWith('.json')) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const providers = parsed && typeof parsed === 'object' ? parsed.providers : undefined;
  const apiKeys = providers && typeof providers === 'object' ? providers.apiKeys : undefined;
  if (!apiKeys || typeof apiKeys !== 'object') return [];
  const findings = [];
  for (const [name, value] of Object.entries(apiKeys)) {
    if (typeof value === 'string' && value.length > 0) {
      findings.push({ name, value });
    }
  }
  return findings;
}

/**
 * The findings in one file's text.
 *
 * WHY IT IS A FUNCTION: the canary self-test below must exercise the SAME
 * detection code as the real scan. A second implementation would prove
 * nothing — the canary would be found by code the real scan does not use.
 */
function scanText(relativePath, text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      pattern.expression.lastIndex = 0;
      let match = pattern.expression.exec(line);
      while (match !== null) {
        const captured = match[pattern.group] ?? match[0];
        if (!looksLikePlaceholder(captured)) {
          found.push({
            file: relativePath,
            line: index + 1,
            rule: pattern.id,
            fingerprint: fingerprint(captured),
          });
        }
        match = pattern.expression.exec(line);
      }
    }
  });

  for (const entry of findApiKeyEntries(relativePath, text)) {
    found.push({
      file: relativePath,
      line: 0,
      rule: 'settings-api-keys',
      fingerprint: fingerprint(entry.value),
    });
  }
  return found;
}

/**
 * Scan one historical blob.
 *
 * WHY the settings rule still fires: `scanText` is called with the blob's
 * ORIGINAL path (so `settings/*.json` apiKeys are checked for every
 * historical version too), and the finding is then re-attributed to the
 * history surface — `history/<path> @ <short-sha>` — so a report line names
 * the commit that carried the leak without printing the leak.
 */
function scanBlobContent(path, sha, buffer) {
  if (buffer.includes(0)) return []; // binary blob
  const found = scanText(path, buffer.toString('utf8'));
  const label = `history/${path || sha.slice(0, 12)} @ ${sha.slice(0, 12)}`;
  for (const finding of found) {
    finding.file = label;
  }
  return found;
}

/**
 * Every blob reachable from any ref, deduplicated by content hash, with the
 * first-seen path attached. Returns null when git is unavailable.
 *
 * WHY deduplication by sha: `rev-list --objects` lists every historical
 * version of every file once per reference; identical content is identical
 * content — scanning it again changes nothing and doubles the runtime.
 */
function historyBlobs() {
  let revs;
  try {
    const out = execFileSync('git', ['rev-list', '--objects', '--all'], {
      cwd: ROOT,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    revs = out.toString('utf8').split(/\r?\n/).filter((line) => line.length > 0);
  } catch {
    return null;
  }
  const pathBySha = new Map();
  for (const line of revs) {
    const spaceAt = line.indexOf(' ');
    const sha = spaceAt === -1 ? line : line.slice(0, spaceAt);
    const path = spaceAt === -1 ? '' : line.slice(spaceAt + 1);
    if (!pathBySha.has(sha)) pathBySha.set(sha, path);
  }
  const shas = [...pathBySha.keys()];
  if (shas.length === 0) return [];
  const batch = spawnSync(
    'git',
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    {
      cwd: ROOT,
      input: Buffer.from(`${shas.join('\n')}\n`, 'utf8'),
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const blobs = [];
  const batchOut = (batch.stdout ?? Buffer.alloc(0)).toString('utf8');
  for (const line of batchOut.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [sha, type, size] = parts;
    if (type !== 'blob') continue;
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    if (bytes > MAX_FILE_BYTES) continue; // not source; the tree scan skips these too
    blobs.push({ sha, path: pathBySha.get(sha) ?? '' });
  }
  return blobs;
}

/**
 * The canary self-test.
 *
 * WHY THIS EXISTS: "no findings" is what a scanner that finds nothing also
 * reports. A scan that has never been shown a secret cannot be trusted to
 * find one. So the scanner plants a canary in a throwaway directory, runs
 * the SAME detection code over it, and refuses to pass unless the canary is
 * found.
 *
 * The canary is assembled from fragments so that this file does not itself
 * contain the literal it is looking for.
 */
function canarySelfTest() {
  // The canary is shaped like the thing it imitates: a vendor prefix, a dash,
  // then a long alphanumeric run. It is assembled from fragments so that this
  // file never contains the literal it searches for, and it avoids every word
  // the placeholder rule treats as "obviously not a secret" — otherwise the
  // self-test would pass for the wrong reason.
  const canary = ['sk', 'canaryNotARealKey0123456789abcdefghij'].join('-');
  const directory = mkdtempSync(join(tmpdir(), 'edugenesis-canary-'));
  try {
    const file = join(directory, 'canary.txt');
    writeFileSync(file, `const credential = "${canary}";\n`, 'utf8');
    const found = scanText('canary.txt', readFileSync(file, 'utf8'));
    if (found.length === 0) {
      return { ok: false, detail: 'the scanner did not detect its own canary token' };
    }
    // The history phase: the SAME detector must find a planted canary in a
    // BLOB — the shape every byte ever committed arrives in. A scanner that
    // finds the canary in a working-tree file but not in a historical blob
    // would leave the git-history blind spot the round-4 audit found open.
    const blobCanary = ['sk', 'canaryHistoryBlob9988776655aabbccddeeff'].join('-');
    const blobFound = scanBlobContent('src/history/canary.ts', 'f'.repeat(40), Buffer.from(`const credential = "${blobCanary}";\n`, 'utf8'));
    if (blobFound.length === 0) {
      return { ok: false, detail: 'the scanner did not detect its canary inside a historical blob' };
    }
    if (!blobFound[0].file.includes('history')) {
      return { ok: false, detail: 'a history-blob finding must be attributed to the history, not to the working tree' };
    }
    return {
      ok: true,
      detail: `the scanner detected its canary in a file and in a historical blob (rules "${found[0]?.rule}", "${blobFound[0]?.rule}") — the detector is live on both surfaces, not inert`,
    };
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // A leaked temp directory is not a scan failure.
    }
  }
}

const selfTest = canarySelfTest();
if (!selfTest.ok) {
  console.error(`FAIL  secrets scan self-test: ${selfTest.detail}.`);
  console.error('A scanner that cannot find a planted canary cannot be trusted to find a real secret.');
  process.exit(1);
}

const findings = [];
let scanned = 0;
let skipped = 0;

for (const relativePath of publishedFiles()) {
  if (isExcluded(relativePath)) {
    skipped += 1;
    continue;
  }
  const absolute = join(ROOT, relativePath);
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    continue;
  }
  if (!stats.isFile()) continue;
  if (stats.size > MAX_FILE_BYTES) {
    skipped += 1;
    continue;
  }
  let text;
  try {
    const buffer = readFileSync(absolute);
    if (buffer.includes(0)) continue; // binary
    text = buffer.toString('utf8');
  } catch {
    skipped += 1;
    continue;
  }
  scanned += 1;
  findings.push(...scanText(relativePath, text));
}

/*
 * The history surface (F6-R4-02): every blob reachable from any ref. Path
 * exclusions do NOT apply here — whatever was once committed was once
 * published, which is precisely the blind spot this scan exists to close.
 * Only oversized and binary blobs are skipped, and each says so in the count.
 */
let historyScanned = 0;
let historySkipped = 0;
const historyFindings = [];
const gitAvailable = existsSync(join(ROOT, '.git'));
if (gitAvailable) {
  const blobs = historyBlobs();
  if (blobs !== null) {
    for (const blob of blobs) {
      let buffer;
      try {
        buffer = execFileSync('git', ['cat-file', 'blob', blob.sha], {
          cwd: ROOT,
          encoding: 'buffer',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: MAX_FILE_BYTES + 1024,
        });
      } catch {
        historySkipped += 1;
        continue;
      }
      if (buffer.includes(0)) {
        historySkipped += 1;
        continue;
      }
      historyScanned += 1;
      historyFindings.push(...scanBlobContent(blob.path, blob.sha, buffer));
    }
  }
}

const allFindings = [...findings, ...historyFindings];

if (allFindings.length > 0) {
  console.error(
    `FAIL  ${allFindings.length} secret finding(s) in ${scanned} tree file(s) and ${historyScanned} history blob(s):\n`,
  );
  for (const finding of allFindings) {
    const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`  ${where}  [${finding.rule}]  ${finding.fingerprint}`);
  }
  console.error('\nNo secret value is printed. Rotate anything that is real, then purge it from the history.');
  process.exit(1);
}

console.log(
  `PASS  secrets scan: ${scanned} tree file(s) and ${historyScanned} history blob(s) scanned, ${skipped + historySkipped} skipped, 0 findings.`,
);
console.log(`PASS  canary self-test: ${selfTest.detail}.`);
if (!gitAvailable) {
  console.log('note  git metadata was not available; the tree was walked and history was not scanned.');
}
process.exit(0);
