/**
 * Project-root discovery and source-file collection.
 *
 * Everything here is derived at runtime from `import.meta.url` and the
 * filesystem. No absolute path is ever written into this source, because the
 * product law requires the project to run on any Windows PC from any folder.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceFile } from './types.js';

/** The workspace package name that marks the project root. */
const PROJECT_PACKAGE_NAME = 'edugenesis-os';

/** Directory names that never contain first-party source. */
const SKIPPED_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'artifacts',
  '.git',
  '.cache',
  'coverage',
  '.next',
  '.turbo',
]);

/** Extensions the static scanners read. */
const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.json',
  '.css',
  '.html',
  '.htm',
  '.svg',
  '.webmanifest',
]);

/** Files larger than this are not scanned (vendored bundles). */
const MAX_FILE_BYTES = 1_500_000;

/** True when the given directory holds the workspace package. */
function isProjectRoot(dir: string): boolean {
  try {
    const raw = readFileSync(join(dir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const name = (parsed as { name?: unknown }).name;
    return name === PROJECT_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * Walk up from `startDir` until the workspace root is found.
 * Falls back to a fixed number of levels up so the harness still works in a
 * copy of the tree that is not a git checkout.
 */
export function findProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    if (isProjectRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir, '..', '..', '..');
}

/** The project root for the currently executing module. */
export function defaultProjectRoot(): string {
  return findProjectRoot(dirname(fileURLToPath(import.meta.url)));
}

/** Normalise a path to POSIX separators for stable reporting. */
export function toPosix(path: string): string {
  return path.split('\\').join('/');
}

/** Project-relative POSIX path of `absPath`. */
export function relativePosix(root: string, absPath: string): string {
  return toPosix(relative(root, absPath));
}

/**
 * Every `src` directory in the workspace: `packages/*\/src` and `apps/*\/src`.
 * Returned as project-relative POSIX paths.
 */
export function listWorkspaceSrcDirs(root: string): string[] {
  const out: string[] = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const srcDir = join(groupDir, name, 'src');
      if (!existsSync(srcDir)) continue;
      out.push(relativePosix(root, srcDir));
    }
  }
  return out;
}

/** Project-relative POSIX paths of the shipped script folder. */
export function listToolsDir(root: string): string[] {
  const toolsDir = join(root, 'tools');
  return existsSync(toolsDir) ? [relativePosix(root, toolsDir)] : [];
}

/** Project-relative POSIX paths of the shipped asset folder. */
export function listAssetsDir(root: string): string[] {
  const assetsDir = join(root, 'assets');
  return existsSync(assetsDir) ? [relativePosix(root, assetsDir)] : [];
}

/**
 * The public folders of the workspace apps: `apps/*\/public`.
 *
 * WHY THEY ARE SCANNED: a static gate that cannot SEE a file cannot police
 * it. The PWA shell (the HTML, the manifest, the icon, the service worker)
 * lives in `apps/cli/public`, and a gate that scanned only `src` would report
 * a clean tree while the shipped assets broke the rule it claims to enforce.
 */
export function listWorkspacePublicDirs(root: string): string[] {
  const out: string[] = [];
  const appsDir = join(root, 'apps');
  if (!existsSync(appsDir)) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(appsDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const publicDir = join(appsDir, name, 'public');
    if (!existsSync(publicDir)) continue;
    out.push(relativePosix(root, publicDir));
  }
  return out;
}

/**
 * EVERY directory the static scanners read.
 *
 * One definition, used by every gate, so the scan scope can never be narrower
 * in one gate than in another. The scope is:
 *
 *   packages/*\/src   the library sources
 *   apps/*\/src        the application sources
 *   apps/*\/public     the shipped browser assets (HTML, CSS, JS, manifest, icon)
 *   tools/             the shipped scripts
 *   assets/            the shipped design tokens and other root assets
 *
 * The earlier scope — `packages/*\/src` and `apps/*\/src` only — was a false
 * negative: the PWA assets it did not cover carried raw colour literals, and
 * the gate that was supposed to prevent exactly that reported PASS.
 */
export function listScannableDirs(root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of [
    ...listWorkspaceSrcDirs(root),
    ...listWorkspacePublicDirs(root),
    ...listToolsDir(root),
    ...listAssetsDir(root),
  ]) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

/**
 * Config files that ship with the project and therefore must also be free of
 * machine-specific absolute paths.
 */
export function listConfigFiles(root: string): string[] {
  const out: string[] = [];
  const candidates = ['package.json', 'tsconfig.base.json', 'tsconfig.json'];
  for (const rel of candidates) {
    if (existsSync(join(root, rel))) out.push(rel);
  }
  for (const group of ['packages', 'apps']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      for (const file of ['tsconfig.json', 'package.json']) {
        const rel = `${group}/${name}/${file}`;
        if (existsSync(join(root, rel))) out.push(rel);
      }
    }
  }
  return out;
}

/** True when the file extension is one the scanners read. */
export function isScannableExtension(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return SCANNED_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** True when the file is a vendored minified bundle (skipped by convention). */
export function isVendoredBundle(path: string): boolean {
  return path.toLowerCase().endsWith('.min.js');
}

function walk(dir: string, out: string[]): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(full);
  }
}

/**
 * Read every scannable source file under the given project-relative folders.
 */
export function collectSourceFiles(root: string, relDirs: readonly string[]): SourceFile[] {
  const files: SourceFile[] = [];
  for (const relDir of relDirs) {
    const absDir = join(root, relDir);
    if (!existsSync(absDir)) continue;
    const candidates: string[] = [];
    walk(absDir, candidates);
    for (const absPath of candidates) {
      if (!isScannableExtension(absPath)) continue;
      if (isVendoredBundle(absPath)) continue;
      let size = 0;
      try {
        size = statSync(absPath).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      let content = '';
      try {
        content = readFileSync(absPath, 'utf8');
      } catch {
        continue;
      }
      files.push({ relPath: relativePosix(root, absPath), absPath, content });
    }
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return files;
}
