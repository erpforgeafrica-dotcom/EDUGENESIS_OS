/**
 * EduGenesis OS — the settings store.
 *
 * RULES ENFORCED HERE
 *  1. The committed default (`settings/settings.json`) is NEVER written by the
 *     CLI. Writes go to `settings/settings.local.json` (untracked) or to an
 *     explicit `--settings <path>` target.
 *  2. Settings are validated against `settings/settings.schema.json`
 *     (JSON Schema draft 2020-12) before they are persisted.
 *  3. Writes are atomic: a temp file is written and then renamed over the
 *     target, so an interrupted write can never truncate a settings file.
 *  4. A settings file with an older `schemaVersion` is MIGRATED: missing keys
 *     are filled from the default, and unknown keys are preserved under
 *     `extra` so nothing is ever dropped silently.
 *  5. An API key is never printed, logged or returned in full.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { EduGenesisSettings } from '@edugenesis/contracts';
import { DEFAULT_SETTINGS_PATH, LOCAL_SETTINGS_PATH, SCHEMA_PATH } from './paths.js';
import { formatIssues, validateAgainstSchema, type SchemaIssue, type SchemaObject } from './schema-validate.js';

/** A settings file on disk. `extra` holds keys the schema does not know. */
export interface SettingsFile extends EduGenesisSettings {
  extra?: Record<string, unknown>;
}

/** The current settings schema version. */
export const SETTINGS_SCHEMA_VERSION = 1;

/** Placeholder printed instead of a secret. */
export const SECRET_MASK = '••••••••';

export interface SettingsLoadResult {
  /** The effective settings (default merged with the local override). */
  readonly settings: SettingsFile;
  /** The committed default file. */
  readonly basePath: string;
  /** The file that was actually used (override when present). */
  readonly activePath: string;
  /** True when the local override was used. */
  readonly usedOverride: boolean;
  /** Schema violations. Empty when the settings are valid. */
  readonly issues: readonly SchemaIssue[];
  /** Migration and hygiene warnings. */
  readonly warnings: readonly string[];
  /** True when the file had to be migrated. */
  readonly migrated: boolean;
}

export interface LoadOptions {
  /** Operate on this exact file instead of the default/override pair. */
  readonly settingsPath?: string | undefined;
}

// ---------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively merge `override` over `base`. Plain objects merge; everything else replaces. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/** Deep-copy a JSON-compatible value without ever exposing `any`. */
export function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  const parsed: unknown = JSON.parse(serialized);
  return parsed as T;
}

// ---------------------------------------------------------------------------
// Schema access
// ---------------------------------------------------------------------------

let cachedSchema: SchemaObject | undefined;

/** Read and cache `settings/settings.schema.json`. */
export function readSchema(): SchemaObject {
  if (cachedSchema) return cachedSchema;
  const raw = readFileSync(SCHEMA_PATH, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) throw new Error(`Settings schema is not a JSON object: ${SCHEMA_PATH}`);
  cachedSchema = parsed;
  return parsed;
}

/** The declared JSON type at a dotted settings path, e.g. `server.port` -> `integer`. */
export function schemaTypeAtPath(schema: SchemaObject, path: string): string | undefined {
  let node: SchemaObject = schema;
  for (const segment of path.split('.')) {
    const properties = isPlainObject(node['properties']) ? node['properties'] : undefined;
    const child = properties && isPlainObject(properties[segment]) ? properties[segment] : undefined;
    if (child) {
      node = child;
      continue;
    }
    const additional = node['additionalProperties'];
    if (isPlainObject(additional)) {
      node = additional;
      continue;
    }
    return undefined;
  }
  return typeof node['type'] === 'string' ? node['type'] : undefined;
}

// ---------------------------------------------------------------------------
// Read / migrate / write
// ---------------------------------------------------------------------------

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

interface MigrationOutcome {
  readonly value: Record<string, unknown>;
  readonly migrated: boolean;
  readonly warnings: string[];
}

/**
 * Migrate a raw settings object onto the current schema.
 * - Missing keys are filled from the default.
 * - Unknown keys are moved under `extra` and reported.
 */
export function migrateSettings(
  raw: unknown,
  defaults: EduGenesisSettings,
  schema: SchemaObject,
): MigrationOutcome {
  const warnings: string[] = [];
  const extra: Record<string, unknown> = {};
  if (!isPlainObject(raw)) {
    return { value: cloneJson(defaults as unknown as Record<string, unknown>), migrated: false, warnings };
  }

  const source: Record<string, unknown> = { ...raw };
  const preserved: Record<string, unknown> = isPlainObject(source['extra']) ? { ...source['extra'] } : {};
  delete source['extra'];

  const migratedValue = migrateNode(source, defaults as unknown as Record<string, unknown>, schema, '', preserved, warnings);

  if (Object.keys(preserved).length > 0) {
    migratedValue['extra'] = { ...(isPlainObject(migratedValue['extra']) ? migratedValue['extra'] : {}), ...preserved };
  }

  const declaredVersion = typeof source['schemaVersion'] === 'number' ? source['schemaVersion'] : 0;
  let versionChanged = false;
  if (declaredVersion < SETTINGS_SCHEMA_VERSION) {
    migratedValue['schemaVersion'] = SETTINGS_SCHEMA_VERSION;
    versionChanged = true;
    warnings.push(`Settings schemaVersion ${declaredVersion} migrated to ${SETTINGS_SCHEMA_VERSION}.`);
  } else if (declaredVersion > SETTINGS_SCHEMA_VERSION) {
    warnings.push(
      `Settings schemaVersion ${declaredVersion} is newer than this build (${SETTINGS_SCHEMA_VERSION}); it was not migrated.`,
    );
  }

  return { value: migratedValue, migrated: versionChanged || warnings.length > 0, warnings };
}

function migrateNode(
  value: Record<string, unknown>,
  fallback: Record<string, unknown>,
  node: SchemaObject,
  path: string,
  extra: Record<string, unknown>,
  warnings: string[],
): Record<string, unknown> {
  const properties = isPlainObject(node['properties']) ? node['properties'] : {};
  const additional = node['additionalProperties'];
  const allowsUnknownKeys = additional !== false && additional !== undefined;
  const out: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    const childSchema = isPlainObject(properties[key]) ? properties[key] : undefined;
    if (childSchema === undefined) {
      if (allowsUnknownKeys) {
        out[key] = child;
      } else {
        extra[childPath] = child;
        warnings.push(`Unknown setting "${childPath}" preserved under "extra".`);
      }
      continue;
    }
    const childFallback = fallback[key];
    if (isPlainObject(child) && isPlainObject(childFallback)) {
      out[key] = migrateNode(child, childFallback, childSchema, childPath, extra, warnings);
    } else if (child === undefined) {
      out[key] = cloneJson(childFallback);
    } else {
      out[key] = child;
    }
  }

  for (const [key, childFallback] of Object.entries(fallback)) {
    if (!(key in out)) {
      out[key] = cloneJson(childFallback);
      const childPath = path ? `${path}.${key}` : key;
      warnings.push(`Missing setting "${childPath}" filled with the default.`);
    }
  }

  return out;
}

/**
 * Load the effective settings.
 * With no `settingsPath`, the committed default is read and the untracked
 * local override is layered on top.
 */
export function loadSettings(options: LoadOptions = {}): SettingsLoadResult {
  const schema = readSchema();
  const warnings: string[] = [];

  if (options.settingsPath) {
    const activePath = resolve(options.settingsPath);
    if (!existsSync(activePath)) {
      throw new Error(`Settings file not found: ${activePath}`);
    }
    const raw = readJsonFile(activePath);
    const defaults = readJsonFile(DEFAULT_SETTINGS_PATH) as EduGenesisSettings;
    const migration = migrateSettings(raw, defaults, schema);
    const issues = validateAgainstSchema(migration.value, schema);
    return {
      settings: migration.value as unknown as SettingsFile,
      basePath: activePath,
      activePath,
      usedOverride: false,
      issues,
      warnings: [...warnings, ...migration.warnings],
      migrated: migration.migrated,
    };
  }

  if (!existsSync(DEFAULT_SETTINGS_PATH)) {
    throw new Error(`Committed default settings file is missing: ${DEFAULT_SETTINGS_PATH}`);
  }
  const baseRaw = readJsonFile(DEFAULT_SETTINGS_PATH);
  const defaults = baseRaw as EduGenesisSettings;
  const baseMigration = migrateSettings(baseRaw, defaults, schema);
  warnings.push(...baseMigration.warnings);

  let effective: unknown = baseMigration.value;
  let activePath = DEFAULT_SETTINGS_PATH;
  let usedOverride = false;

  if (existsSync(LOCAL_SETTINGS_PATH)) {
    const overrideRaw = readJsonFile(LOCAL_SETTINGS_PATH);
    const overrideMigration = migrateSettings(overrideRaw, defaults, schema);
    warnings.push(...overrideMigration.warnings);
    effective = deepMerge(baseMigration.value, overrideMigration.value);
    activePath = LOCAL_SETTINGS_PATH;
    usedOverride = true;
  }

  const issues = validateAgainstSchema(effective, schema);
  const migrated = baseMigration.migrated || (usedOverride ? warnings.length > 0 : false);

  return {
    settings: effective as SettingsFile,
    basePath: DEFAULT_SETTINGS_PATH,
    activePath,
    usedOverride,
    issues,
    warnings,
    migrated,
  };
}

/**
 * Write a settings file atomically.
 * The committed default is refused — the CLI must never mutate it.
 */
export function writeSettingsFile(targetPath: string, settings: SettingsFile): void {
  const target = resolve(targetPath);
  if (target === resolve(DEFAULT_SETTINGS_PATH)) {
    throw new Error(
      `Refusing to write the committed default settings file (${DEFAULT_SETTINGS_PATH}). ` +
        `The CLI writes to ${LOCAL_SETTINGS_PATH} or to an explicit --settings target.`,
    );
  }
  const schema = readSchema();
  const issues = validateAgainstSchema(settings, schema);
  if (issues.length > 0) {
    throw new Error(`Refusing to write invalid settings:\n  ${formatIssues(issues).join('\n  ')}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  const payload = `${JSON.stringify(settings, null, 2)}\n`;
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporary, target);
  } catch (error) {
    try {
      writeFileSync(target, payload, { encoding: 'utf8', mode: 0o600 });
    } catch {
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Reading and writing individual settings
// ---------------------------------------------------------------------------

/** Read a value at a dotted path. */
export function getByPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Write a value at a dotted path. Returns false when the parent does not exist. */
export function setByPath(root: unknown, path: string, value: unknown): boolean {
  const segments = path.split('.');
  let current: unknown = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (!isPlainObject(current)) return false;
    const segment = segments[index] as string;
    if (!isPlainObject(current[segment])) {
      if (current[segment] !== undefined) return false;
      current[segment] = {};
    }
    current = current[segment];
  }
  if (!isPlainObject(current)) return false;
  const last = segments[segments.length - 1] as string;
  current[last] = value;
  return true;
}

/**
 * List every settable leaf path.
 * `providers.apiKeys` is a dynamic map, so each provider key is listed on its own.
 */
export function listLeafPaths(root: unknown, prefix = ''): string[] {
  if (!isPlainObject(root)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(root)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      if (path === 'providers.apiKeys') {
        const names = Object.keys(value);
        if (names.length === 0) out.push(path);
        for (const name of names) out.push(`${path}.${name}`);
        continue;
      }
      out.push(...listLeafPaths(value, path));
      continue;
    }
    out.push(path);
  }
  return out;
}

/** True when the path addresses a secret. */
export function isSecretPath(path: string): boolean {
  return path === 'providers.apiKeys' || path.startsWith('providers.apiKeys.');
}

/** Render a secret without revealing it. */
export function maskSecret(value: string): string {
  return `${SECRET_MASK}, ${value.length} chars`;
}

/** A copy of the settings with every secret masked for display. */
export function maskSettingsForDisplay(settings: SettingsFile): Record<string, unknown> {
  const copy = cloneJson(settings as unknown as Record<string, unknown>);
  const apiKeys = getByPath(copy, 'providers.apiKeys');
  if (isPlainObject(apiKeys)) {
    const masked: Record<string, string> = {};
    for (const [name, value] of Object.entries(apiKeys)) {
      masked[name] = typeof value === 'string' ? maskSecret(value) : SECRET_MASK;
    }
    setByPath(copy, 'providers.apiKeys', masked);
  }
  return copy;
}

/** A description of the stored secrets that never contains a secret. */
export function describeApiKeys(settings: SettingsFile): Record<string, { set: boolean; length: number }> {
  const apiKeys = getByPath(settings, 'providers.apiKeys');
  const out: Record<string, { set: boolean; length: number }> = {};
  if (!isPlainObject(apiKeys)) return out;
  for (const [name, value] of Object.entries(apiKeys)) {
    out[name] = { set: typeof value === 'string' && value.length > 0, length: typeof value === 'string' ? value.length : 0 };
  }
  return out;
}

/** Coerce a raw CLI string into the type the schema declares for the path. */
export function coerceValue(raw: string, declaredType: string | undefined): unknown {
  switch (declaredType) {
    case 'integer': {
      if (!/^-?\d+$/.test(raw.trim())) throw new Error(`"${raw}" is not an integer.`);
      return Number.parseInt(raw.trim(), 10);
    }
    case 'number': {
      const parsed = Number(raw.trim());
      if (!Number.isFinite(parsed)) throw new Error(`"${raw}" is not a number.`);
      return parsed;
    }
    case 'boolean': {
      const normalized = raw.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
      if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
      throw new Error(`"${raw}" is not a boolean (use true or false).`);
    }
    default:
      return raw;
  }
}
