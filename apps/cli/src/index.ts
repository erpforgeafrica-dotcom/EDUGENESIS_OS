#!/usr/bin/env node
/**
 * `eg` — the EduGenesis OS command line.
 *
 * A tiny dispatcher. No framework, no dependency. Each command lives in its
 * own module so the root package.json scripts can call it directly:
 *
 *   node apps/cli/dist/doctor.js
 *   node apps/cli/dist/settings.js list
 *   node apps/cli/dist/serve.js
 *   node apps/cli/dist/selftest.js
 */
import { parseArgs, type ParsedArgs } from './args.js';
import { isMainModule, PROJECT_ROOT, displayPath } from './paths.js';

const USAGE = `EduGenesis OS — eg

Usage:
  eg doctor [--json]           Check the environment, the settings and the tree
  eg settings <action> ...     list | get <key> | set <key> <value> | path
  eg serve                     Start the local server and the Settings UI
  eg selftest [--json]         Run the platform self-test

Global options:
  --settings <path>            Operate on an alternate settings file
  --json                       Machine-readable output

Everything is stored inside this project folder (${displayPath(PROJECT_ROOT)}).
Nothing is written outside it, and no API key is ever printed in full.`;

/** Re-serialize parsed arguments so a sub-command can parse them again. */
function serialize(args: ParsedArgs): string[] {
  const out: string[] = [...args.positional];
  for (const [name, value] of args.flags) {
    if (typeof value === 'string') out.push(`--${name}`, value);
    else if (value) out.push(`--${name}`);
  }
  return out;
}

/** The `eg` entry point. Returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const rest = serialize(args);

  switch (args.command) {
    case '':
    case 'help':
    case '--help':
      process.stdout.write(`${USAGE}\n`);
      return 0;
    case 'version':
    case '--version':
      process.stdout.write('edugenesis-os 0.1.0\n');
      return 0;
    case 'doctor': {
      const module = await import('./doctor.js');
      return module.main(rest);
    }
    case 'settings': {
      const module = await import('./settings.js');
      return module.main(rest);
    }
    case 'serve': {
      const module = await import('./serve.js');
      return module.main(rest);
    }
    case 'selftest': {
      const module = await import('./selftest.js');
      return module.main(rest);
    }
    default:
      process.stderr.write(`Unknown command "${args.command}".\n\n${USAGE}\n`);
      return 1;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`eg failed: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
