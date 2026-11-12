/**
 * `eg selftest` — the platform's own self-test.
 *
 * It resolves the accessibility validator, the OneKey gateway, the ledger and
 * the identity/consent services **when their packages are built**. A package
 * that is not built yet is reported as unavailable; it is never a failure.
 *
 * A package that IS built but throws while loading, or that exposes no
 * callable entry point at all, IS a failure — that is a broken build.
 *
 * The probe uses a dynamic import so this command never fails at module-load
 * time because a sibling package is still being compiled.
 */
import { flagBoolean, parseArgs } from './args.js';
import { renderTable } from './format.js';
import { isMainModule } from './paths.js';

type ProbeStatus = 'OK' | 'SKIP' | 'FAIL';

interface PackageProbe {
  /** Stable identifier used in the report. */
  readonly id: string;
  /** The workspace package specifier. */
  readonly specifier: string;
  /** Factory export names that, when present, are instantiated as a smoke check. */
  readonly factories: readonly string[];
}

const PROBES: readonly PackageProbe[] = [
  {
    id: 'accessibility',
    specifier: '@edugenesis/accessibility',
    factories: [
      'createValidator',
      'createAccessibilityValidator',
      'createDefaultValidator',
      'createGuardian',
      'createAccessibilityGuardian',
    ],
  },
  {
    id: 'onekey',
    specifier: '@edugenesis/onekey',
    factories: ['createGateway', 'createOneKeyGateway', 'createDefaultGateway'],
  },
  {
    id: 'ledger',
    specifier: '@edugenesis/ledger',
    factories: ['createLedger', 'createLedgerStore', 'openLedger', 'createInMemoryLedger'],
  },
  {
    id: 'identity',
    specifier: '@edugenesis/identity',
    factories: ['createIdentityService', 'createConsentService', 'createIdentity', 'createConsent'],
  },
  {
    id: 'contracts',
    specifier: '@edugenesis/contracts',
    factories: [],
  },
];

interface ProbeResult {
  readonly id: string;
  readonly specifier: string;
  readonly status: ProbeStatus;
  readonly detail: string;
  readonly note: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function importModule(specifier: string): Promise<Record<string, unknown>> {
  const loaded = (await import(specifier)) as unknown;
  if (!isRecord(loaded)) throw new Error('The module did not export an object.');
  return loaded;
}

function isConstructorName(value: unknown): boolean {
  return typeof value === 'function';
}

/** Probe one package. Never throws. */
async function probePackage(probe: PackageProbe): Promise<ProbeResult> {
  let module: Record<string, unknown>;
  try {
    module = await importModule(probe.specifier);
  } catch (error) {
    const message = (error as Error).message.split('\n')[0] ?? 'unknown error';
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') {
      return {
        id: probe.id,
        specifier: probe.specifier,
        status: 'SKIP',
        detail: 'Package is not built yet — unavailable.',
        note: message,
      };
    }
    return {
      id: probe.id,
      specifier: probe.specifier,
      status: 'FAIL',
      detail: `The package is built but failed to load: ${message}`,
      note: message,
    };
  }

  const exported = Object.entries(module);
  const callables = exported.filter(([, value]) => isConstructorName(value));
  if (callables.length === 0) {
    return {
      id: probe.id,
      specifier: probe.specifier,
      status: 'FAIL',
      detail: 'The package exposes no callable entry point.',
      note: `exports: ${exported.map(([name]) => name).join(', ') || '(none)'}`,
    };
  }

  let note = `exports: ${exported.map(([name]) => name).join(', ')}`;
  const factoryName = probe.factories.find((name) => isConstructorName(module[name]));
  if (factoryName) {
    try {
      const factory = module[factoryName] as () => unknown;
      const instance = factory();
      const shape = isRecord(instance) ? Object.keys(instance).join(', ') : typeof instance;
      note = `${note} | ${factoryName}() instantiated (${shape || 'no own properties'})`;
    } catch (error) {
      note = `${note} | ${factoryName}() raised: ${(error as Error).message.split('\n')[0] ?? 'unknown error'}`;
    }
  } else if (probe.factories.length > 0) {
    note = `${note} | no recognised factory among [${probe.factories.join(', ')}]`;
  }

  return {
    id: probe.id,
    specifier: probe.specifier,
    status: 'OK',
    detail: `Loaded — ${callables.length} callable export(s).`,
    note,
  };
}

/** Run every probe. */
export async function runSelftest(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const probe of PROBES) {
    results.push(await probePackage(probe));
  }
  return results;
}

/** The `selftest` command. Returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const results = await runSelftest();
  const failures = results.filter((result) => result.status === 'FAIL');
  const skipped = results.filter((result) => result.status === 'SKIP');

  if (flagBoolean(args, 'json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: failures.length === 0,
          counts: {
            ok: results.length - failures.length - skipped.length,
            skipped: skipped.length,
            failed: failures.length,
          },
          results: results.map((result) => ({
            id: result.id,
            specifier: result.specifier,
            status: result.status,
            detail: result.detail,
            note: result.note,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write('EduGenesis OS — platform self-test\n\n');
    process.stdout.write(
      `${renderTable(
        ['STATUS', 'PACKAGE', 'DETAIL'],
        results.map((result) => [result.status, result.id, result.detail]),
      )}\n\n`,
    );
    for (const result of results) {
      process.stdout.write(`${result.id}: ${result.note}\n`);
    }
    process.stdout.write(
      `\nSummary: ${results.length - failures.length - skipped.length} OK, ${skipped.length} unavailable, ${failures.length} failed.\n`,
    );
  }

  return failures.length === 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`eg selftest failed: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
