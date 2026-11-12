/**
 * Runtime loading of sibling workspace packages.
 *
 * The other swarm units build `packages/accessibility`, `packages/onekey`,
 * `packages/ledger` and `packages/identity` in parallel. This harness must
 * therefore:
 *   - run against them when they exist,
 *   - report "not built" (a warning, never a false pass) when they do not,
 *   - never import one of them at compile time, because the compiler would
 *     then fail the whole build whenever a parallel unit has not landed yet.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A workspace package that was resolved at runtime. */
export interface LoadedPackage {
  readonly name: string;
  readonly module: unknown;
  readonly exports: Record<string, unknown>;
  /** How the package was found — useful evidence in a gate report. */
  readonly source: 'package-resolution' | 'dist-fallback';
}

/** Narrow an unknown value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow an unknown value to a callable. */
export function asFunction(value: unknown): ((...args: unknown[]) => unknown) | undefined {
  if (typeof value !== 'function') return undefined;
  return value as (...args: unknown[]) => unknown;
}

/** Every export of a module as a plain record. */
export function toExportRecord(module: unknown): Record<string, unknown> {
  if (!isRecord(module)) return {};
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(module)) out[name] = value;
  return out;
}

/** A sorted, comma separated list of export names — safe to print. */
export function describeExports(exports: Record<string, unknown>): string {
  const names = Object.keys(exports).sort();
  return names.join(', ');
}

/** Exports whose name satisfies the predicate. */
export function findExports(
  exports: Record<string, unknown>,
  predicate: (name: string) => boolean,
): Array<{ name: string; value: unknown }> {
  return Object.entries(exports)
    .filter(([name]) => predicate(name))
    .map(([name, value]) => ({ name, value }));
}

/**
 * Load a workspace package by name, falling back to its built entry point.
 * Returns `null` when the package is absent or not built.
 */
export async function loadWorkspacePackage(
  root: string,
  packageName: string,
  relativeDir: string,
): Promise<LoadedPackage | null> {
  try {
    const specifier: string = packageName;
    const module: unknown = await import(specifier);
    const exports = toExportRecord(module);
    if (Object.keys(exports).length > 0) {
      return { name: packageName, module, exports, source: 'package-resolution' };
    }
  } catch {
    // Not resolvable by package name yet (not built, or not linked).
  }
  const candidate = join(root, relativeDir, 'dist', 'index.js');
  if (!existsSync(candidate)) return null;
  try {
    const module: unknown = await import(pathToFileURL(candidate).href);
    return {
      name: packageName,
      module,
      exports: toExportRecord(module),
      source: 'dist-fallback',
    };
  } catch {
    return null;
  }
}

/**
 * Try to instantiate an export: first as a zero-argument factory, then as a
 * constructor. Both paths are guarded because sibling units own the real
 * signatures.
 */
export function instantiate(value: unknown): unknown[] {
  const results: unknown[] = [];
  const fn = asFunction(value);
  if (!fn) return results;
  try {
    results.push(fn());
  } catch {
    // not a factory
  }
  try {
    const constructed: unknown = Reflect.construct(fn, []);
    results.push(constructed);
  } catch {
    // not constructible
  }
  return results;
}
