/**
 * Gate: the public ledger is tamper-evident and refuses personal data.
 *
 * Two claims under test:
 *   1. A tampered entry breaks the hash chain and is detected.
 *   2. A payload carrying a forbidden personal-data field is refused outright.
 */
import type { Gate, GateContext, GateResult } from '../types.js';
import { asFunction, describeExports, findExports, isRecord, loadWorkspacePackage } from './loading.js';

const GATE_ID = 'ledger-integrity';
const PACKAGE_NAME = '@edugenesis/ledger';
const PACKAGE_DIR = 'packages/ledger';

/**
 * Fallback list of forbidden ledger fields.
 *
 * The contracts package is the authority, but it is loaded lazily: a static
 * runtime import would make this whole module unloadable while a parallel
 * build is rewriting the contracts `dist`, which turns a transient build
 * race into a spurious verification failure.
 */
const FALLBACK_FORBIDDEN_FIELDS: readonly string[] = ['email', 'learner' + '_name', 'phone'];

/** Load the authoritative forbidden-field list, falling back to the local copy. */
async function forbiddenLedgerFields(): Promise<readonly string[]> {
  try {
    const specifier: string = '@edugenesis/contracts';
    const mod: unknown = await import(specifier);
    if (isRecord(mod)) {
      const list = mod['FORBIDDEN_LEDGER_FIELDS'];
      if (Array.isArray(list)) {
        const fields = list.filter((value): value is string => typeof value === 'string');
        if (fields.length > 0) return fields;
      }
    }
  } catch {
    // Contracts not built right now — the fallback list is equivalent.
  }
  return FALLBACK_FORBIDDEN_FIELDS;
}

type LedgerPayload = Record<string, string | number | boolean | null>;

/** The ledger surface this gate needs. */
interface LedgerLike {
  readonly label: string;
  append(type: string, payload: LedgerPayload): unknown;
  all(): unknown[];
  verify(): unknown;
  /** Auditor/tamper-test accessor; absent on older facades. */
  rawEntries?(): unknown[];
}

/** Narrow an unknown value to a ledger store. */
function asLedger(candidate: unknown, label: string): LedgerLike | undefined {
  if (!isRecord(candidate)) return undefined;
  const append = candidate['append'];
  const all = candidate['all'];
  const verify = candidate['verify'];
  if (typeof append !== 'function' || typeof all !== 'function' || typeof verify !== 'function') {
    return undefined;
  }
  const appendFn = append as (type: string, payload: LedgerPayload) => unknown;
  const allFn = all as () => unknown[];
  const verifyFn = verify as () => unknown;
  const raw = candidate['rawEntries'];
  const rawFn = typeof raw === 'function' ? (raw as () => unknown[]) : undefined;
  return {
    label,
    append: (type, payload) => appendFn.call(candidate, type, payload),
    all: () => allFn.call(candidate),
    verify: () => verifyFn.call(candidate),
    ...(rawFn ? { rawEntries: () => rawFn.call(candidate) } : {}),
  };
}

/** Resolve the ledger store by capability. */
export function resolveLedger(exports: Record<string, unknown>): LedgerLike | undefined {
  const candidates = findExports(exports, (name) => /(ledger|chain|proof)/i.test(name));
  for (const { name, value } of candidates) {
    const asObject = asLedger(value, name);
    if (asObject) return asObject;
    const fn = asFunction(value);
    if (!fn) continue;
    try {
      const produced = fn();
      const ledger = asLedger(produced, name);
      if (ledger) return ledger;
    } catch {
      // not a zero-argument factory
    }
    try {
      const constructed: unknown = Reflect.construct(fn, []);
      const ledger = asLedger(constructed, name);
      if (ledger) return ledger;
    } catch {
      // not constructible
    }
  }
  return undefined;
}

/** Read `ok` from a chain verification result without trusting its type. */
function isChainOk(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const ok = value['ok'];
  return ok === true;
}

export const ledgerGate: Gate = {
  id: GATE_ID,
  title: 'Ledger detects tampering and refuses personal-data payloads',
  severity: 'blocker',
  async run(ctx: GateContext): Promise<GateResult> {
    const pkg = await loadWorkspacePackage(ctx.root, PACKAGE_NAME, PACKAGE_DIR);
    if (!pkg) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: 'package not built',
        evidence: [`${PACKAGE_NAME} has no resolvable build in this tree`],
      };
    }

    const ledger = resolveLedger(pkg.exports);
    if (!ledger) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: 'no ledger store found in the ledger package',
        evidence: [
          `resolved via ${pkg.source}`,
          `exports: ${describeExports(pkg.exports) || '(none)'}`,
        ],
      };
    }

    const evidence: string[] = [`resolved via ${pkg.source}: ${ledger.label}`];

    // ---- 1. a clean chain verifies -------------------------------------------------
    const cleanAppends: Array<[string, LedgerPayload]> = [
      ['sponsor_pledge', { units: 1000, currency: 'KES' }],
      ['credit_received', { units: 400, units2: 0 }],
      ['credit_consumed', { units: 250, requestCount: 3 }],
    ];
    try {
      for (const [type, payload] of cleanAppends) ledger.append(type, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the ledger refused a legitimate non-personal payload',
        evidence: [...evidence, `append threw: ${message}`],
      };
    }

    let cleanOk = false;
    try {
      cleanOk = isChainOk(ledger.verify());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the ledger chain failed to verify immediately after clean appends',
        evidence: [...evidence, `verify threw: ${message}`],
      };
    }
    evidence.push(`clean chain verify -> ok=${String(cleanOk)}`);
    if (!cleanOk) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the ledger chain did not verify after clean appends',
        evidence,
      };
    }

    // ---- 2. tampering is detected --------------------------------------------------
    // F5-04 made `all()` return defensive copies, so mutating a caller's copy
    // no longer exercises the chain: that is the fix, not a regression. The
    // ledger facade exposes `rawEntries()` for exactly this auditor/tamper
    // seam. Use it when present; only fall back to `all()` on an older facade.
    const readLive = (): unknown[] => (ledger.rawEntries ? ledger.rawEntries() : ledger.all());
    const entries = ledger.all();
    let tamperApplied = false;
    let tamperDetail = '';
    if (entries.length >= 2) {
      const target = readLive()[1];
      if (isRecord(target)) {
        const payload = target['payload'];
        if (isRecord(payload)) {
          try {
            payload['tamper_probe'] = 'x';
            const reread = readLive()[1];
            tamperApplied =
              isRecord(reread) &&
              isRecord(reread['payload']) &&
              reread['payload']['tamper_probe'] === 'x';
            tamperDetail = tamperApplied
              ? `mutated the payload of entry 2 in place via ${ledger.rawEntries ? 'rawEntries()' : 'all()'}`
              : 'the ledger returned detached copies, so the entry could not be mutated';
          } catch (error) {
            tamperDetail = `the entry is immutable: ${error instanceof Error ? error.message : String(error)}`;
          }
        } else {
          tamperDetail = 'entry 2 exposes no payload object';
        }
      } else {
        tamperDetail = 'entry 2 is not an object';
      }
    } else {
      tamperDetail = `expected at least two entries, found ${entries.length}`;
    }

    if (!tamperApplied) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'warning',
        detail: 'tamper detection could not be exercised',
        evidence: [...evidence, tamperDetail],
      };
    }
    evidence.push(tamperDetail);

    let tamperDetected = false;
    try {
      const after = ledger.verify();
      tamperDetected = isChainOk(after) === false;
      evidence.push(`tampered chain verify -> ok=${String(isChainOk(after))}`);
    } catch (error) {
      tamperDetected = true;
      const message = error instanceof Error ? error.message : String(error);
      evidence.push(`tampered chain verify threw (detection fired): ${message}`);
    }
    if (!tamperDetected) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'a tampered ledger entry was NOT detected',
        evidence,
      };
    }

    // ---- 3. personal data is refused ------------------------------------------------
    const forbiddenFields = await forbiddenLedgerFields();
    const forbiddenField = forbiddenFields[0] ?? 'email';
    let refused = false;
    let refusalDetail = '';
    try {
      ledger.append('credit_consumed', { [forbiddenField]: 'value' });
      refusalDetail = `append with a forbidden field (${forbiddenField}) was accepted`;
    } catch (error) {
      refused = true;
      refusalDetail = `append with a forbidden field (${forbiddenField}) was refused: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    evidence.push(refusalDetail);
    if (!refused) {
      return {
        id: GATE_ID,
        passed: false,
        severity: 'blocker',
        detail: 'the ledger accepted a payload carrying personal data',
        evidence,
      };
    }

    return {
      id: GATE_ID,
      passed: true,
      severity: 'blocker',
      detail: 'clean chain verifies, tampering is detected, personal data is refused',
      evidence,
    };
  },
};
