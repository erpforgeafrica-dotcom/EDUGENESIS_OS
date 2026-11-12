/**
 * EduGenesis OS — path resolution.
 *
 * PORTABILITY LAW (GLOBAL.md §9 / ADR-0016): a copy of this folder must run
 * on any Windows machine under any user name, on any drive letter. Therefore
 * every path used by the CLI is derived from the location of this module or
 * from the project root discovered by walking up from it. No absolute path,
 * user name or drive letter is ever written into a source file.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Directory of the compiled (or source) module that owns this file. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * A directory is the project root when it carries the workspace manifest and
 * the two workspace folders. This is structural — no name matching.
 */
function looksLikeProjectRoot(dir: string): boolean {
  return (
    existsSync(join(dir, 'package.json')) &&
    existsSync(join(dir, 'packages')) &&
    existsSync(join(dir, 'apps'))
  );
}

/**
 * Walk up from `start` until the project root is found.
 * Fallback: `apps/cli/{src,dist}` -> `apps/cli` -> `apps` -> `<root>`.
 */
export function findProjectRoot(start: string = MODULE_DIR): string {
  let dir = resolve(start);
  for (;;) {
    if (looksLikeProjectRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(MODULE_DIR, '..', '..', '..');
}

/** Absolute path of the project root. */
export const PROJECT_ROOT = findProjectRoot();

/** `settings/` — versioned, schema-validated settings. Never a secret. */
export const SETTINGS_DIR = join(PROJECT_ROOT, 'settings');

/** The committed default settings file. The CLI never writes to it. */
export const DEFAULT_SETTINGS_PATH = join(SETTINGS_DIR, 'settings.json');

/** The untracked local override. This is where the CLI writes. */
export const LOCAL_SETTINGS_PATH = join(SETTINGS_DIR, 'settings.local.json');

/** JSON Schema (draft 2020-12) for the settings file. */
export const SCHEMA_PATH = join(SETTINGS_DIR, 'settings.schema.json');

/** The Aurora design tokens. Copied into the project so nothing is read from outside it. */
export const TOKENS_PATH = join(PROJECT_ROOT, 'assets', 'edugenesis-tokens.css');

/** Compiled shared contracts. */
export const CONTRACTS_ENTRY = join(PROJECT_ROOT, 'packages', 'contracts', 'dist', 'index.js');

/** Static assets of the Settings UI (`apps/cli/public`). */
export const PUBLIC_DIR = resolve(MODULE_DIR, '..', 'public');

/** True when the current process was started with this module as its entry point. */
export function isMainModule(metaUrl: string): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    const target = pathToFileURL(realpathSync(resolve(invoked))).href;
    return target === new URL(metaUrl).href;
  } catch {
    try {
      return pathToFileURL(resolve(invoked)).href === new URL(metaUrl).href;
    } catch {
      return false;
    }
  }
}

/** `settings/settings.local.json` — the only file the CLI is allowed to write. */
export function localOverridePath(): string {
  return LOCAL_SETTINGS_PATH;
}

/** True when `target` is the committed default settings file. */
export function isCommittedDefault(target: string): boolean {
  try {
    return resolve(target) === resolve(DEFAULT_SETTINGS_PATH);
  } catch {
    return false;
  }
}

/** A short, human-readable label for a path inside the project. */
export function displayPath(target: string): string {
  const rel = resolve(target).replace(resolve(PROJECT_ROOT), '.').replace(/\\/g, '/');
  return rel.startsWith('.') ? rel : basename(target);
}
