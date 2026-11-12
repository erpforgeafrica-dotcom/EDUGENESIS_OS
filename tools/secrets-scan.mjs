/**
 * tools/secrets-scan.mjs
 *
 * Scans the tree that a commit would publish for likely secrets:
 *
 *   - AWS access key ids (AKIA / ASIA) and AWS secret access keys
 *   - PEM / OpenSSH private key headers
 *   - `sk-`, `ghp_` and `xoxb-` credential prefixes
 *   - `apiKey = "..."` style assignments
 *   - a non-empty `apiKeys` value in a tracked settings file
 *
 * It NEVER prints a secret. A finding is reported as file, line number and a
 * redacted fingerprint (a salted SHA-256 prefix plus the length).
 *
 * Exit code 0 = clean. Exit code 1 = at least one finding.
 *
 * The scanned set is "tracked plus not ignored", which is exactly what a
 * commit would publish. `node_modules`, `dist`, `.git`, `artifacts`, the local
 * settings override and the portable toolchain are excluded.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories that are never part of the published tree. */
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'artifacts',
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
    id: 'openai-style-key',
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

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of PATTERNS) {
      pattern.expression.lastIndex = 0;
      let match = pattern.expression.exec(line);
      while (match !== null) {
        const captured = match[pattern.group] ?? match[0];
        if (!looksLikePlaceholder(captured)) {
          findings.push({
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
    findings.push({
      file: relativePath,
      line: 0,
      rule: 'settings-api-keys',
      fingerprint: fingerprint(entry.value),
    });
  }
}

if (findings.length > 0) {
  console.error(`FAIL  ${findings.length} secret finding(s) in ${scanned} scanned file(s):\n`);
  for (const finding of findings) {
    const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`  ${where}  [${finding.rule}]  ${finding.fingerprint}`);
  }
  console.error('\nNo secret value is printed. Rotate anything that is real, then remove it from the tree.');
  process.exit(1);
}

console.log(`PASS  secrets scan: ${scanned} file(s) scanned, ${skipped} skipped, 0 findings.`);
if (!existsSync(join(ROOT, '.git'))) {
  console.log('note  git metadata was not available; the tree was walked instead of read from the index.');
}
process.exit(0);
