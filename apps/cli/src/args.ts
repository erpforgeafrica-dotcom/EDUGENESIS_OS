/**
 * A tiny argument parser. No framework, no dependency.
 *
 *   eg settings set server.port 8799
 *   eg doctor --json
 *   eg settings list --settings path/to/settings.json
 */
export interface ParsedArgs {
  /** The first non-flag token. Empty when none was given. */
  readonly command: string;
  /** The remaining non-flag tokens. */
  readonly positional: readonly string[];
  /** `--name value`, `--name=value` and `--name` (boolean true). */
  readonly flags: ReadonlyMap<string, string | boolean>;
}

/** Flags that never take a value, so `--json` never swallows the next token. */
const BOOLEAN_FLAGS = new Set(['json', 'help']);

/** Parse an argv tail (without `node` and the script path). */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let onlyPositional = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (onlyPositional) {
      positional.push(token);
      continue;
    }
    if (token === '--') {
      onlyPositional = true;
      continue;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      if (equals >= 0) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--') && !BOOLEAN_FLAGS.has(body)) {
        flags.set(body, next);
        index += 1;
        continue;
      }
      flags.set(body, true);
      continue;
    }
    positional.push(token);
  }

  const command = positional.length > 0 ? (positional[0] as string) : '';
  return { command, positional: positional.slice(1), flags };
}

/** Read a string flag. */
export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** Read a boolean flag. */
export function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}
