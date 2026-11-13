/**
 * The egress boundary — what a request is allowed to carry to a model provider.
 *
 * WHY THIS EXISTS
 *   The provider adapter receives a `CompletionRequest` and hands it to a third
 *   party. Nothing in the type system stops a caller from attaching a learner's
 *   name, a disability note or a safeguarding flag to that object, and a
 *   provider SDK will happily serialise whatever it is given. This module is
 *   the one place that decides what may leave the process.
 *
 * THE RULE IS DENY-BY-DEFAULT, NOT ALLOW-BY-EXCEPTION
 *   A field travels only if its NAME is on the allowlist. A new field added to
 *   a request is therefore rejected until someone deliberately allows it and
 *   writes a test for it. The alternative — allow everything, deny a blocklist
 *   of sensitive names — fails silently the first time a field is renamed.
 *
 * WHY VALUES MUST BE SCALAR
 *   An allowlist entry vouches for a field's name, not for the shape inside it.
 *   A nested object is an unbounded surface: `{ context: [{ source, text }] }`
 *   can carry anything at any depth, and no name check can see it. Grounded
 *   context therefore needs its own projector before it may be sent; until
 *   then it is refused, which is the safe direction to be wrong in.
 *
 * WHY `sensitive` AND `secret` ARE REFUSED EVEN IF ALLOWLISTED
 *   Doc 2 §27 is categorical: those classes never leave the private store. A
 *   caller cannot opt out of that by adding a field name to the allowlist, so
 *   the data-class check is independent of the allowlist and runs after it.
 *
 * Governance: Doc 2 §27 (data classification), Doc 6 §3.6, ADR-0001.
 */
import type { DataClass } from '@edugenesis/contracts';

/**
 * The fields a provider may receive.
 *
 * `accessibilityProfileHash` is present and `accessibilityProfile` is not: the
 * contract says the hash travels and the profile itself never does.
 */
export const DEFAULT_EGRESS_ALLOWLIST: readonly string[] = [
  'prompt',
  'system',
  'dataClass',
  'safetyTier',
  'accessibilityProfileHash',
  'locale',
  'maxOutputTokens',
  'requiresAccessibilityContract',
];

/** Classes that never leave the process, whatever the allowlist says. */
export const NEVER_EGRESS_DATA_CLASSES: readonly DataClass[] = ['sensitive', 'secret'];

/** Ordered from least to most restrictive, for the ceiling comparison. */
const DATA_CLASS_RANK: Readonly<Record<DataClass, number>> = {
  public: 0,
  learner_scoped: 1,
  sensitive: 2,
  secret: 3,
};

export interface EgressOptions {
  /** Replace the allowlist. Defaults to `DEFAULT_EGRESS_ALLOWLIST`. */
  readonly allowlist?: readonly string[];
  /**
   * The highest data class the destination is cleared to receive.
   * Defaults to `learner_scoped`: a hosted model may see pseudonymous,
   * minimised learner context, never more.
   */
  readonly maxDataClass?: DataClass;
}

/**
 * A refused payload. `fields` names every offending field, not just the first,
 * so a caller can fix the whole object in one pass instead of one field per
 * round trip.
 */
export class EgressRejectedError extends Error {
  readonly fields: readonly string[];
  readonly reason: string;

  constructor(fields: readonly string[], reason: string) {
    super(`Egress refused: ${reason}${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`);
    this.name = 'EgressRejectedError';
    this.fields = [...fields];
    this.reason = reason;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isDataClass(value: unknown): value is DataClass {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DATA_CLASS_RANK, value);
}

/**
 * Project a request onto the allowlist, or throw.
 *
 * Returns a NEW object containing only allowlisted, scalar, defined fields.
 * The input is never mutated, so a rejected call cannot have partially
 * stripped the caller's object.
 */
export function projectEgressPayload(
  payload: Record<string, unknown>,
  options: EgressOptions = {},
): Record<string, unknown> {
  if (!isPlainObject(payload)) {
    throw new EgressRejectedError([], 'the payload must be a plain object');
  }

  const allowlist = new Set(options.allowlist ?? DEFAULT_EGRESS_ALLOWLIST);
  const ceiling = options.maxDataClass ?? 'learner_scoped';
  const unknown: string[] = [];
  const nested: string[] = [];
  const projected: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(payload)) {
    if (value === undefined) {
      // An absent optional field is not an egress decision; omit it entirely
      // rather than sending `undefined` and hoping the SDK drops it.
      continue;
    }
    if (!allowlist.has(field)) {
      unknown.push(field);
      continue;
    }
    if (value === null) {
      // `null` is an explicit value and must be allowlisted like any other,
      // but it carries no content, so it cannot widen the surface.
      projected[field] = null;
      continue;
    }
    if (!isScalar(value)) {
      nested.push(field);
      continue;
    }
    projected[field] = value;
  }

  if (unknown.length > 0) {
    throw new EgressRejectedError(unknown, 'field(s) not on the egress allowlist');
  }
  if (nested.length > 0) {
    throw new EgressRejectedError(nested, 'field(s) carry a nested value the allowlist cannot inspect');
  }

  const declared = projected['dataClass'];
  if (declared !== undefined) {
    if (!isDataClass(declared)) {
      throw new EgressRejectedError(['dataClass'], 'the data class is not a recognised class');
    }
    if (NEVER_EGRESS_DATA_CLASSES.includes(declared)) {
      throw new EgressRejectedError(['dataClass'], `a "${declared}" payload never leaves the private store`);
    }
    if (DATA_CLASS_RANK[declared] > DATA_CLASS_RANK[ceiling]) {
      throw new EgressRejectedError(
        ['dataClass'],
        `a "${declared}" payload exceeds this destination's ceiling of "${ceiling}"`,
      );
    }
  }

  return projected;
}

/**
 * The non-throwing form, for a caller that must record the refusal rather than
 * abort a request.
 */
export function tryProjectEgressPayload(
  payload: Record<string, unknown>,
  options: EgressOptions = {},
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: EgressRejectedError } {
  try {
    return { ok: true, payload: projectEgressPayload(payload, options) };
  } catch (error) {
    if (error instanceof EgressRejectedError) return { ok: false, error };
    throw error;
  }
}
