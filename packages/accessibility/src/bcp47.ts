/**
 * BCP-47 language tag validation.
 *
 * ARC-I5 requires `language.primary` to be a *valid* BCP-47 tag (07 §5.3).
 * A single loose regex would accept nonsense such as "en--US" or "englishish",
 * so this module parses the RFC 5646 langtag grammar subtag by subtag and
 * validates every subtag's shape, length and position.
 *
 * Scope note (deliberate): validation is SYNTACTIC (RFC 5646 §2.1 ABNF).
 * Registry membership is not checked — the IANA subtag registry changes over
 * time and is not bundled with this package, so a well-formed but unregistered
 * tag such as "a-DE" passes. Callers that need registry semantics must consult
 * the registry themselves.
 */

/** One extension sequence ("u-islamcal" → singleton "u", subtag "islamcal"). */
export interface Bcp47Extension {
  readonly singleton: string;
  readonly subtags: readonly string[];
}

/** A parsed BCP-47 tag, in canonical case. */
export interface Bcp47Tag {
  readonly language: string;
  readonly extlangs: readonly string[];
  readonly script: string | undefined;
  readonly region: string | undefined;
  readonly variants: readonly string[];
  readonly extensions: readonly Bcp47Extension[];
  readonly privateUse: readonly string[];
  readonly grandfathered: boolean;
  readonly canonical: string;
}

/** The outcome of parsing: a structure, or the reason for refusal. */
export type Bcp47ParseResult =
  | { readonly ok: true; readonly tag: Bcp47Tag }
  | { readonly ok: false; readonly error: string };
const ALPHA = /^[A-Za-z]+$/;
const ALNUM = /^[A-Za-z0-9]+$/;
const DIGITS = /^[0-9]+$/;

/**
 * Grandfathered tags (RFC 5646 §2.2.8). They predate the current langtag
 * grammar — "i-klingon" has a one-character language subtag and "en-GB-oed"
 * carries a three-character variant — so they are recognised explicitly
 * instead of being rejected as malformed.
 */
const GRANDFATHERED: ReadonlyMap<string, string> = new Map([
  ['art-lojban', 'art-lojban'],
  ['cel-gaulish', 'cel-gaulish'],
  ['en-gb-oed', 'en-GB-oed'],
  ['i-ami', 'i-ami'],
  ['i-bnn', 'i-bnn'],
  ['i-default', 'i-default'],
  ['i-enochian', 'i-enochian'],
  ['i-hak', 'i-hak'],
  ['i-klingon', 'i-klingon'],
  ['i-lux', 'i-lux'],
  ['i-mingo', 'i-mingo'],
  ['i-navajo', 'i-navajo'],
  ['i-pwn', 'i-pwn'],
  ['i-tao', 'i-tao'],
  ['i-tay', 'i-tay'],
  ['i-tsu', 'i-tsu'],
  ['no-bok', 'no-bok'],
  ['no-nyn', 'no-nyn'],
  ['sgn-be-fr', 'sgn-BE-FR'],
  ['sgn-be-nl', 'sgn-BE-NL'],
  ['sgn-ch-de', 'sgn-CH-DE'],
  ['zh-guoyu', 'zh-guoyu'],
  ['zh-hakka', 'zh-hakka'],
  ['zh-min', 'zh-min'],
  ['zh-min-nan', 'zh-min-nan'],
  ['zh-xiang', 'zh-xiang'],
]);

function fail(error: string): Bcp47ParseResult {
  return { ok: false, error };
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function parsePrivateUseOnly(parts: readonly string[]): Bcp47ParseResult {
  const privateUse: string[] = [];
  for (const part of parts.slice(1)) {
    if (part.length < 1 || part.length > 8 || !ALNUM.test(part)) {
      return fail(`private-use subtag "${part}" must be 1-8 alphanumeric characters`);
    }
    privateUse.push(part.toLowerCase());
  }
  if (privateUse.length === 0) {
    return fail('a private-use tag must carry at least one subtag after "x"');
  }
  return {
    ok: true,
    tag: {
      language: 'x',
      extlangs: [],
      script: undefined,
      region: undefined,
      variants: [],
      extensions: [],
      privateUse,
      grandfathered: false,
      canonical: ['x', ...privateUse].join('-'),
    },
  };
}

/**
 * Parses a BCP-47 tag. Returns the parsed structure or a reason for refusal.
 */
export function parseBcp47(input: string): Bcp47ParseResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return fail('the tag is empty');
  }

  const grandfathered = GRANDFATHERED.get(trimmed.toLowerCase());
  if (grandfathered !== undefined) {
    const language = (grandfathered.split('-')[0] ?? grandfathered).toLowerCase();
    return {
      ok: true,
      tag: {
        language,
        extlangs: [],
        script: undefined,
        region: undefined,
        variants: [],
        extensions: [],
        privateUse: [],
        grandfathered: true,
        canonical: grandfathered,
      },
    };
  }

  const parts = trimmed.split('-');
  for (const [position, part] of parts.entries()) {
    if (part.length === 0) {
      return fail(`subtag ${position} is empty — a tag may not contain an empty subtag`);
    }
  }

  const first = parts[0];
  if (first === undefined) {
    return fail('the tag is empty');
  }
  if (first.toLowerCase() === 'x') {
    return parsePrivateUseOnly(parts);
  }

  if (first.length < 2 || first.length > 8 || !ALPHA.test(first)) {
    return fail(`language subtag "${first}" must be 2-8 alphabetic characters`);
  }
  const language = first.toLowerCase();
  let index = 1;

  const extlangs: string[] = [];
  while (extlangs.length < 3) {
    const part = parts[index];
    if (part === undefined || part.length !== 3 || !ALPHA.test(part)) {
      break;
    }
    extlangs.push(part.toLowerCase());
    index += 1;
  }

  let script: string | undefined;
  const scriptPart = parts[index];
  if (scriptPart !== undefined && scriptPart.length === 4 && ALPHA.test(scriptPart)) {
    script = titleCase(scriptPart);
    index += 1;
  }

  let region: string | undefined;
  const regionPart = parts[index];
  if (regionPart !== undefined) {
    if (regionPart.length === 2 && ALPHA.test(regionPart)) {
      region = regionPart.toUpperCase();
      index += 1;
    } else if (regionPart.length === 3 && DIGITS.test(regionPart)) {
      region = regionPart;
      index += 1;
    }
  }

  const variants: string[] = [];
  for (;;) {
    const part = parts[index];
    if (part === undefined) {
      break;
    }
    if (!ALNUM.test(part)) {
      return fail(`subtag "${part}" is not alphanumeric and cannot be a variant`);
    }
    const isDigitLedFour = part.length === 4 && DIGITS.test(part.charAt(0));
    if (part.length > 8) {
      return fail(`variant subtag "${part}" is longer than the 8-character maximum`);
    }
    if (!((part.length >= 5 && part.length <= 8) || isDigitLedFour)) {
      break;
    }
    variants.push(part.toLowerCase());
    index += 1;
  }

  const extensions: Bcp47Extension[] = [];
  while (index < parts.length) {
    const singleton = parts[index];
    if (singleton === undefined) {
      break;
    }
    if (singleton.length !== 1 || !ALNUM.test(singleton)) {
      return fail(`subtag "${singleton}" does not fit the BCP-47 langtag grammar`);
    }
    if (singleton.toLowerCase() === 'x') {
      break;
    }
    index += 1;
    const subtags: string[] = [];
    while (index < parts.length) {
      const part = parts[index];
      if (part === undefined) {
        break;
      }
      if (part.length < 2 || part.length > 8 || !ALNUM.test(part)) {
        break;
      }
      subtags.push(part.toLowerCase());
      index += 1;
    }
    if (subtags.length === 0) {
      return fail(`extension "${singleton}" must be followed by at least one subtag`);
    }
    extensions.push({ singleton: singleton.toLowerCase(), subtags });
  }

  const privateUse: string[] = [];
  if (index < parts.length) {
    const marker = parts[index];
    if (marker !== undefined && marker.toLowerCase() === 'x') {
      index += 1;
      for (; index < parts.length; index += 1) {
        const part = parts[index];
        if (part === undefined) {
          continue;
        }
        if (part.length < 1 || part.length > 8 || !ALNUM.test(part)) {
          return fail(`private-use subtag "${part}" must be 1-8 alphanumeric characters`);
        }
        privateUse.push(part.toLowerCase());
      }
      if (privateUse.length === 0) {
        return fail('a private-use sequence must carry at least one subtag after "x"');
      }
    }
  }

  if (index < parts.length) {
    return fail(`subtag "${parts[index] ?? ''}" does not fit the BCP-47 langtag grammar`);
  }

  const canonicalParts: string[] = [language, ...extlangs];
  if (script !== undefined) {
    canonicalParts.push(script);
  }
  if (region !== undefined) {
    canonicalParts.push(region);
  }
  canonicalParts.push(...variants);
  for (const extension of extensions) {
    canonicalParts.push(extension.singleton, ...extension.subtags);
  }
  if (privateUse.length > 0) {
    canonicalParts.push('x', ...privateUse);
  }

  return {
    ok: true,
    tag: {
      language,
      extlangs,
      script,
      region,
      variants,
      extensions,
      privateUse,
      grandfathered: false,
      canonical: canonicalParts.join('-'),
    },
  };
}

/** True when the tag parses as BCP-47. */
export function isValidBcp47(input: string): boolean {
  return parseBcp47(input).ok;
}

/**
 * The canonical spelling of a tag (RFC 5646 §2.1.1 canonical case), or null
 * when the tag is not a valid BCP-47 tag.
 */
export function canonicalizeBcp47(input: string): string | null {
  const parsed = parseBcp47(input);
  return parsed.ok ? parsed.tag.canonical : null;
}
