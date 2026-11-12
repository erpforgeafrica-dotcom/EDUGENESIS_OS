/**
 * `eg settings` — get, set and list settings.
 *
 *   eg settings list
 *   eg settings get server.port
 *   eg settings set server.port 8799
 *   eg settings set providers.apiKeys.<providerId> <secret>
 *
 * The committed default (`settings/settings.json`) is never written by this
 * command. Writes go to `settings/settings.local.json` (untracked) or to an
 * explicit `--settings <path>` target, which is what the portability gate uses.
 *
 * An API key is never printed in full.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { flagBoolean, flagString, parseArgs } from './args.js';
import { displayPath, isMainModule, LOCAL_SETTINGS_PATH } from './paths.js';
import {
  coerceValue,
  getByPath,
  isPlainObject,
  isSecretPath,
  listLeafPaths,
  loadSettings,
  maskSecret,
  maskSettingsForDisplay,
  readSchema,
  schemaTypeAtPath,
  setByPath,
  writeSettingsFile,
  type SettingsFile,
} from './settings-store.js';

const USAGE = `Usage:
  eg settings list [--json]
  eg settings get <key> [--json]
  eg settings set <key> <value> [--settings <path>]
  eg settings path

  <key> is a dotted path, for example server.port, features.telemetry,
  providers.apiKeys.<providerId>.`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  throw new ExitSignal();
}

/** Internal control-flow signal; never surfaces as an error message. */
class ExitSignal extends Error {
  constructor() {
    super('exit');
    this.name = 'ExitSignal';
  }
}

/** Reject a path whose parent does not exist in the settings. */
function assertKnownPath(settings: SettingsFile, path: string, declaredType: string | undefined): void {
  if (declaredType === undefined) fail(`Unknown setting "${path}". Run "eg settings list" to see the settable keys.`);
  const segments = path.split('.');
  for (let index = 0; index < segments.length - 1; index += 1) {
    const parent = getByPath(settings, segments.slice(0, index + 1).join('.'));
    if (parent === undefined) {
      fail(`Unknown setting "${path}". Run "eg settings list" to see the settable keys.`);
    }
  }
}

function renderValue(path: string, value: unknown): string {
  if (isSecretPath(path)) {
    if (typeof value === 'string') return maskSecret(value);
    if (isPlainObject(value)) {
      const parts = Object.entries(value).map(([name, secret]) =>
        typeof secret === 'string' ? `${name}=${maskSecret(secret)}` : `${name}=••••••••`,
      );
      return parts.length > 0 ? parts.join(', ') : '(none)';
    }
    return '(none)';
  }
  if (value === undefined) return '(unset)';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The `settings` command. Returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const subcommand = args.command === '' ? 'list' : args.command;
  const explicitPath = flagString(args, 'settings');
  const asJson = flagBoolean(args, 'json');

  try {
    if (subcommand === 'help' || subcommand === '--help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }

    if (subcommand === 'path') {
      const loaded = explicitPath ? loadSettings({ settingsPath: explicitPath }) : loadSettings();
      const target = explicitPath ? resolve(explicitPath) : LOCAL_SETTINGS_PATH;
      process.stdout.write(`${displayPath(target)}\n`);
      if (!asJson) process.stdout.write(`Reading from: ${displayPath(loaded.activePath)}\n`);
      return 0;
    }

    // ---- list ------------------------------------------------------------
    if (subcommand === 'list') {
      const loaded = explicitPath ? loadSettings({ settingsPath: explicitPath }) : loadSettings();
      if (loaded.issues.length > 0) {
        process.stderr.write(`The settings file does not validate against the schema:\n`);
        for (const issue of loaded.issues) process.stderr.write(`  ${issue.path}: ${issue.message}\n`);
        return 1;
      }
      if (asJson) {
        process.stdout.write(`${JSON.stringify(maskSettingsForDisplay(loaded.settings), null, 2)}\n`);
        return 0;
      }
      const display = maskSettingsForDisplay(loaded.settings);
      const paths = listLeafPaths(display);
      const width = paths.reduce((max, path) => Math.max(max, path.length), 0);
      process.stdout.write(`Settings file: ${displayPath(loaded.activePath)}\n`);
      if (loaded.usedOverride) process.stdout.write('(local override layered over the committed default)\n');
      process.stdout.write('\n');
      for (const path of paths) {
        const value = getByPath(display, path);
        process.stdout.write(`${path.padEnd(width)}  ${renderValue(path, value)}\n`);
      }
      for (const warning of loaded.warnings) process.stdout.write(`\nwarning: ${warning}\n`);
      return 0;
    }

    // ---- get -------------------------------------------------------------
    if (subcommand === 'get') {
      const path = args.positional[0];
      if (!path) fail(`"eg settings get" needs a key.\n${USAGE}`);
      const loaded = explicitPath ? loadSettings({ settingsPath: explicitPath }) : loadSettings();
      const value = getByPath(loaded.settings, path);
      if (value === undefined) fail(`Unknown setting "${path}". Run "eg settings list" to see the settable keys.`);
      if (asJson) {
        const masked = isSecretPath(path) ? maskSecret(String(value)) : value;
        process.stdout.write(`${JSON.stringify(masked, null, 2)}\n`);
        return 0;
      }
      process.stdout.write(`${renderValue(path, value)}\n`);
      return 0;
    }

    // ---- set -------------------------------------------------------------
    if (subcommand === 'set') {
      const path = args.positional[0];
      const rawValue = args.positional[1];
      if (!path || rawValue === undefined) fail(`"eg settings set" needs a key and a value.\n${USAGE}`);

      const schema = readSchema();
      const declaredType = schemaTypeAtPath(schema, path);

      const target = explicitPath ? resolve(explicitPath) : LOCAL_SETTINGS_PATH;
      let base: SettingsFile;
      if (explicitPath) {
        base = existsSync(explicitPath)
          ? loadSettings({ settingsPath: explicitPath }).settings
          : (loadSettings().settings as SettingsFile);
      } else {
        base = loadSettings().settings;
      }

      assertKnownPath(base, path, declaredType);

      let coerced: unknown;
      try {
        coerced = coerceValue(rawValue, declaredType);
      } catch (error) {
        fail((error as Error).message);
      }

      const updated = JSON.parse(JSON.stringify(base)) as SettingsFile;
      if (!setByPath(updated, path, coerced)) fail(`Could not apply "${path}".`);

      writeSettingsFile(target, updated);

      if (asJson) {
        process.stdout.write(`${JSON.stringify({ key: path, set: true, file: displayPath(target) }, null, 2)}\n`);
        return 0;
      }
      if (isSecretPath(path)) {
        const secret = String(getByPath(updated, path) ?? '');
        process.stdout.write(`set ${path} (${maskSecret(secret)})\n`);
      } else {
        process.stdout.write(`set ${path} = ${renderValue(path, coerced)}\n`);
      }
      process.stdout.write(`written to ${displayPath(target)}\n`);
      return 0;
    }

    fail(`Unknown subcommand "${subcommand}".\n${USAGE}`);
  } catch (error) {
    if (error instanceof ExitSignal) return 1;
    process.stderr.write(`eg settings failed: ${(error as Error).message}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`eg settings failed: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
