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
import type { CompletionRequest, DataClass, SafetyTier } from '@edugenesis/contracts';

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
 * The shape a grounded-context entry may take once it has been projected.
 *
 * The locator is a CONTENT identifier (`curriculum:algebra/linear-eq`), never a
 * filesystem path and never a URL: a `file://` locator would put the build
 * machine's directory layout on a third party's server, and a URL could name an
 * internal host. Only `locator` and `text` travel — the rest of the lineage
 * record (the licence, the retrieval time, the tier) stays in the process.
 */
export interface EgressGroundedContextEntry {
  readonly locator: string;
  readonly text: string;
}

/** Limits on what a grounded context may carry. */
export interface GroundedContextOptions {
  /** Largest single entry, in characters. */
  readonly maxChars?: number;
  /** Largest number of entries that may travel. */
  readonly maxEntries?: number;
}

const DEFAULT_MAX_CONTEXT_CHARS = 4_000;
const DEFAULT_MAX_CONTEXT_ENTRIES = 50;

/** URL schemes that never name a content identifier. */
const UNSAFE_LOCATOR_SCHEMES: readonly string[] = [
  'apex', 'blob', 'data', 'file', 'ftp', 'ftps', 'gopher', 'jar', 'javascript',
  'nfs', 'sftp', 'smb', 'vbscript', 'ws', 'wss',
];

/**
 * The unsafe SHAPES, checked against a locator and against each decoded form.
 *
 * Every rule below is a different spelling of the same leak — "this string
 * names a file on the build machine" — and each one was reachable before this
 * check existed:
 *
 *   letter-colon-separator   drive-absolute (either separator)
 *   letter-colon-name        drive-RELATIVE: the old pattern required a
 *                            separator, so this passed and named a file
 *                            relative to the process's drive
 *   leading separator        POSIX-absolute, Windows-rooted
 *   double separator         UNC network path
 *   tilde                    home-relative
 *   dot-dot, dot             traversal, leading or embedded
 *   scheme-colon             file:, data:, javascript: and friends
 *   any://                   a URL with an authority
 *   scheme:/                 a filesystem root named after a scheme
 * Bare relative segments like `curriculum:algebra/linear-eq` stay permitted:
 * they are the platform's content identifiers and name no host or drive.
 */
function isUnsafeLocatorShape(value: string): boolean {
  if (/^[A-Za-z]:/.test(value)) return true;
  if (value.startsWith('/') || value.startsWith('\\')) return true;
  if (/^~($|[\\/])/.test(value)) return true;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return true;
  if (/(^|[\\/])\.([\\/]|$)/.test(value)) return true;
  if (value.includes('://')) return true;
  // `scheme:/absolute` and `scheme:\absolute` name a filesystem root even
  // though the string does not begin with a separator.
  if (value.includes(':/') || value.includes(':\\')) return true;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  if (scheme && UNSAFE_LOCATOR_SCHEMES.includes((scheme[1] ?? '').toLowerCase())) return true;
  return false;
}

/**
 * True when a locator names a filesystem path or a URL rather than content.
 *
 * THE CHECK IS ON THE VALUE, NOT THE SPELLING: it runs on the trimmed locator,
 * then on every percent-decoded form up to two passes, because an encoded
 * traversal is still a traversal to whoever decodes it downstream. A malformed
 * escape is refused rather than passed through unexamined.
 */
function locatorIsUnsafe(locator: string): boolean {
  if (locator.length === 0 || locator.length > 200) return true;
  const value = locator.trim();
  if (value.length === 0) return true;
  // eslint-disable-next-line no-control-regex -- the control characters ARE the thing being rejected
  if (/[\u0000-\u001F\u007F]/.test(value)) return true;
  if (isUnsafeLocatorShape(value)) return true;
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) break;
    decoded = next;
    // eslint-disable-next-line no-control-regex -- the control characters ARE the thing being rejected
    if (/[\u0000-\u001F\u007F]/.test(decoded)) return true;
    if (isUnsafeLocatorShape(decoded)) return true;
  }
  return false;
}

/**
 * Project grounded context onto the shape that may leave the process.
 *
 * WHY THIS EXISTS: the module's own rule says a nested value is an unbounded
 * surface — `{ context: [{ source, text }] }` can carry anything at any depth
 * and no name check can see it — so grounded context needs its own projector
 * before it may be sent. Until one existed, the only real provider adapter
 * shipped the raw context to a third party, and the egress boundary was dead
 * code on the only path that mattered.
 *
 * THE PROJECTION IS CLOSED: exactly two string fields leave. The locator is
 * checked to be a content identifier, the text is bounded in length, and the
 * entry count is bounded. Everything else about the lineage stays inside.
 *
 * IT FAILS CLOSED: an unsafe locator, an oversized entry, a non-string text or
 * too many entries is REFUSED, not silently dropped. Silently dropping the
 * grounding would change the model's answer without saying so.
 */
export function projectGroundedContext(
  context: readonly (
    | { source: { locator: string }; text: string }
    | EgressGroundedContextEntry
  )[],
  options: GroundedContextOptions = {},
): EgressGroundedContextEntry[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_CONTEXT_ENTRIES;

  if (!Array.isArray(context)) {
    throw new EgressRejectedError(['context'], 'the grounded context must be an array');
  }
  if (context.length > maxEntries) {
    throw new EgressRejectedError(
      ['context'],
      `the grounded context carries ${String(context.length)} entries; at most ${String(maxEntries)} may travel`,
    );
  }

  const out: EgressGroundedContextEntry[] = [];
  for (const entry of context) {
    if (typeof entry !== 'object' || entry === null) {
      throw new EgressRejectedError(['context'], 'a grounded-context entry must be an object');
    }
    // F8-07: accept BOTH the raw SourceLineage shape and an already-projected
    // { locator, text } entry. The second form makes the gateway's single
    // projection idempotent, so an adapter that still projects internally
    // (Qwen) keeps grounding correctly on its own second pass.
    const rawSource = 'source' in entry ? entry.source : undefined;
    const locator =
      rawSource !== undefined && typeof rawSource === 'object' && 'locator' in rawSource
        ? rawSource.locator
        : 'locator' in entry
          ? entry.locator
          : undefined;
    if (typeof locator !== 'string' || locatorIsUnsafe(locator)) {
      throw new EgressRejectedError(
        ['context'],
        'a grounded-context locator must be a content identifier, not a filesystem path or a URL',
      );
    }
    const text = entry.text;
    if (typeof text !== 'string') {
      throw new EgressRejectedError(['context'], 'a grounded-context entry must carry text');
    }
    if (text.length > maxChars) {
      throw new EgressRejectedError(
        ['context'],
        `a grounded-context entry is ${String(text.length)} characters; at most ${String(maxChars)} may travel`,
      );
    }
    if (text.includes('\u0000')) {
      throw new EgressRejectedError(['context'], 'a grounded-context entry carries a NUL character');
    }
    out.push({ locator, text });
  }
  return out;
}

/**
 * A CompletionRequest after the egress boundary has projected it.
 *
 * F8-07: this is the ONLY shape a registered adapter receives from the
 * gateway. Every field is allowlisted and scalar, and `context` has been
 * projected onto `{ locator, text }` — the full SourceLineage (licence,
 * retrieval time, tier, source id) never crosses the boundary.
 */
export interface EgressSafeRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly dataClass: DataClass;
  readonly safetyTier: SafetyTier;
  readonly accessibilityProfileHash?: string;
  readonly locale?: string;
  readonly maxOutputTokens: number;
  readonly requiresAccessibilityContract: boolean;
  /** Projected grounded context — locator and text only, never the full lineage. */
  readonly context: EgressGroundedContextEntry[];
}

/**
 * Project a whole request in ONE place, or throw.
 *
 * F8-07: the gateway calls this once immediately before handing a request to
 * any registered adapter. The projection is idempotent, so an adapter that
 * still projects internally (Qwen) grounds correctly on its own second pass.
 * A request carrying an unknown field or an unsafe locator is REFUSED here,
 * before any adapter can serialise it to a third party.
 */
export function projectRequestForEgress(
  req: CompletionRequest,
  options: EgressOptions & GroundedContextOptions = {},
): EgressSafeRequest {
  const { context, ...rest } = req;
  const projected = projectEgressPayload(rest as unknown as Record<string, unknown>, options);
  const grounded = projectGroundedContext(context ?? [], options);
  return { ...projected, context: grounded } as unknown as EgressSafeRequest;
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
