#!/usr/bin/env node
/**
 * tools/approval-subject.mjs — the ONE definition of "what was approved".
 *
 * WHY A SHARED MODULE: the signer and the verifier must build the subject with
 * byte-identical rules. Two copies of those rules would drift, and the first
 * symptom of drift would be a release that cannot be verified at the moment it
 * matters. Both tools import this file.
 *
 * TWO RULES THAT ARE EASY TO GET WRONG, AND ARE THEREFORE EXPLICIT:
 *
 * 1. TRACKED FILES ONLY. The first version of this code walked the four
 *    directories and hashed whatever it found. That included nine
 *    `tsconfig.tsbuildinfo` files, which are gitignored build output: a fresh
 *    clone has none of them, and every rebuild rewrites them. The digest could
 *    therefore only ever verify on the one machine that produced it. The
 *    subject is the TRACKED tree (`git ls-files`), because the tracked tree is
 *    exactly what ships; the walk-based fallback applies the same exclusions so
 *    a machine without git produces the same digest.
 *
 * 2. CANONICAL LF. Git normalises text to LF in the repository but a Windows
 *    checkout with `core.autocrlf=true` writes CRLF, so the raw bytes of the
 *    same approved file differ between a Windows and a Linux clone. Hashing raw
 *    bytes would make a Linux CI run reject a Windows-approved release for a
 *    reason that is not a content change. Every file is hashed in canonical LF
 *    form: CRLF becomes LF and nothing else changes (a lone CR is preserved,
 *    because git does not rewrite it). `bytes` is the canonical length.
 *
 * Zero runtime dependencies (ADR-0014).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const SUBJECT_DIRS = Object.freeze(['packages', 'apps', 'tools', 'docs']);

/** Deliberately outside the subject: signing them would be circular. */
export const EXCLUDED = Object.freeze([
  'docs/RELEASE-APPROVAL.md',
  'docs/RELEASE-APPROVAL.sig',
]);

/** Generated, ignored, or not part of a shipping source tree. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const SKIP_SUFFIXES = ['.tsbuildinfo'];

/** CRLF -> LF. A lone CR is left alone: git does not rewrite it. */
export function canonicalBytes(buffer) {
  const out = Buffer.allocUnsafe(buffer.length);
  let written = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    if (byte === 0x0d && buffer[i + 1] === 0x0a) {
      out[written] = 0x0a;
      written += 1;
      i += 1;
    } else {
      out[written] = byte;
      written += 1;
    }
  }
  return out.subarray(0, written);
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      if (SKIP_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Paths under the subject scope that will ship: tracked plus untracked-but-not-
 * ignored. Ignored build output is excluded by git itself, so a ceremony run
 * before `git add` and one run after it agree. Null when git is unavailable.
 */
function trackedPaths(root) {
  try {
    const stdout = execFileSync(
      'git',
      ['ls-files', '--full-name', '-z', '--cached', '--others', '--exclude-standard', '--', ...SUBJECT_DIRS],
      { cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout
      .toString('utf8')
      .split('\0')
      .filter((line) => line !== '')
      .map((line) => line.split(sep).join('/'));
  } catch {
    return null;
  }
}

/**
 * Build the approval subject.
 * @returns {{ schemaVersion: number, scope: readonly string[], excluded: string[],
 *             mode: 'tracked' | 'walk', files: { path: string, bytes: number, sha256: string }[],
 *             canonical: string, digest: string }}
 */
export function buildSubject(root) {
  const tracked = trackedPaths(root);
  let paths;
  if (tracked !== null) {
    paths = tracked;
  } else {
    const files = [];
    for (const dir of SUBJECT_DIRS) {
      const full = join(root, dir);
      if (existsSync(full)) walk(full, files);
    }
    paths = files.map((file) => relative(root, file).split(sep).join('/'));
  }

  const files = paths
    .filter((path) => !EXCLUDED.includes(path))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((path) => {
      const absolute = join(root, path.split('/').join(sep));
      if (!existsSync(absolute)) {
        throw new Error(`the approval subject names ${path}, which is not on disk`);
      }
      const canonical = canonicalBytes(readFileSync(absolute));
      return {
        path,
        bytes: canonical.length,
        sha256: createHash('sha256').update(canonical).digest('hex'),
      };
    });

  const canonical = JSON.stringify({
    schemaVersion: 1,
    scope: SUBJECT_DIRS,
    excluded: [...EXCLUDED].sort(),
    files,
  });

  return {
    schemaVersion: 1,
    scope: SUBJECT_DIRS,
    excluded: [...EXCLUDED].sort(),
    mode: tracked === null ? 'walk' : 'git',
    files,
    canonical,
    digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  };
}
