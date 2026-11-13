/**
 * EduGenesis OS — PII guard for the public ledger boundary.
 *
 * WHY THIS EXISTS
 * The ledger is published. Every byte in it is visible to the world, forever,
 * and cannot be retracted (Doc 2 §2.5; Doc 16 §3.5). The private operational
 * store holds learner identity, consent, safeguarding and accessibility records
 * and must never reach the ledger (Doc 2 §15).
 *
 * Two independent lines of defence are implemented here:
 *
 *   LINE 1 — FIELD NAME. The frozen contract lists 21 field names that may
 *     never appear in a ledger payload (`FORBIDDEN_LEDGER_FIELDS`). This module
 *     extends that list and matches names AFTER NORMALISATION, so `learnerId`,
 *     `learner_id`, `LEARNER_ID` and `learner.id` are all caught by one rule.
 *     Matching is recursive: nested objects and arrays are walked to the leaves.
 *
 *   LINE 2 — VALUE SHAPE. A field name is not a guarantee. A field called
 *     `contact` can hold an email-shaped value under an innocuous name. This
 *     line detects values that look like an email address or like a phone
 *     number / national id.
 *
 * LINE 2 IS DELIBERATELY CONSERVATIVE. It is tuned to be used on a PUBLIC
 * artefact, so it errs towards false positives on values that are obviously
 * machine identifiers (hex digests, ISO dates) rather than letting a personal
 * identifier through. Every exemption is documented inline with its reason.
 *
 * The two documented limitations are real and are recorded rather than hidden:
 *   - Numeric values are NOT scanned for digit patterns. Money in this platform
 *     is integer minor units (cents), so a large amount legitimately looks like
 *     a long digit string. The field-name rule covers the money-bearing keys.
 *   - Short national ids (8 digits) are caught only when they appear under a
 *     forbidden field name; a bare 8-digit value under an innocuous key is not
 *     distinguishable from an ordinary identifier.
 */

import { FORBIDDEN_LEDGER_FIELDS } from '@edugenesis/contracts';

/**
 * Extended forbidden-name list.
 *
 * The contract's 21 names are the FLOOR, not the ceiling: it lists the obvious
 * identifiers, but a payload can also leak a learner through `full_name`,
 * `msisdn`, `latitude` and friends. This list is a strict superset and is the
 * reason the guard catches `learnerId` (camelCase), which is not literally in the
 * contract list but is obviously the same concept.
 *
 * Matching is exact-after-normalisation, never substring: `sponsor_name` is an
 * organisational identifier and stays legal, while `name` (in the contract list)
 * is refused.
 */
export const EXTENDED_FORBIDDEN_LEDGER_FIELDS: readonly string[] = [
  // Identity of a person (contract list covers learner_name / guardian_name).
  'learnerid',
  'learnername',
  'learneremail',
  'learnerphone',
  'learnerage',
  'learnergrade',
  'learnerclass',
  'studentid',
  'studentname',
  'studentemail',
  'pupilid',
  'pupilname',
  'childid',
  'childname',
  'parentid',
  'parentname',
  'parentemail',
  'guardianid',
  'firstname',
  'lastname',
  'fullname',
  'givenname',
  'surname',
  'middlename',
  'fathername',
  'mothername',
  'contactname',
  'contactemail',
  'contactphone',
  // Contact channels.
  'emailaddress',
  'phonenumber',
  'mobilenumber',
  'mobile',
  'msisdn',
  'telephone',
  // Government / civic identifiers.
  'nationalidnumber',
  'idnumber',
  'passportnumber',
  'passport',
  'taxid',
  'dateofbirth',
  'birthdate',
  'birthday',
  'placeofbirth',
  'ageband',
  // Location (the contract list covers address / location / lat / lon).
  'homeaddress',
  'streetaddress',
  'postaladdress',
  'postcode',
  'zipcode',
  'latitude',
  'longitude',
  'gpscoordinates',
  'geolocation',
  'coordinates',
  // Health and accessibility (the contract list covers disability / health).
  'disabilitytype',
  'healthstatus',
  'medicalrecord',
  'learningdisability',
  'specialneeds',
  'biometricid',
  'fingerprint',
  'faceprint',
  'voiceprint',
  // Free text and learner content (the contract list covers message / transcript / prompt).
  'chatmessage',
  'sms',
  'messagebody',
  'rawtranscript',
  'learnerprompt',
  'userprompt',
  'prompttext',
  'freetext',
];

/**
 * Characters that RENDER as an ASCII letter but are a different code point.
 *
 * WHY: `learner_id` written with a Cyrillic `е` (U+0435) instead of a Latin `e`
 * is a different string that a human reviewer reads as the same field. The
 * previous normaliser stripped every non-ASCII character, which turned the
 * look-alike spelling into the unrelated token `lrnrid` and let a forbidden
 * name through. Folding first makes the comparison see what the reader sees.
 *
 * WHY IT IS AN EXTENSION, NOT A NARROWING: ledger field names are machine
 * identifiers. A genuine Cyrillic or Greek identifier is not a field this
 * platform produces, so folding it can only create a refusal, never hide one.
 */
const CONFUSABLE_LETTERS: Readonly<Record<string, string>> = {
  // Cyrillic lower-case look-alikes.
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h',
  'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i',
  'ї': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ғ': 'f',
  'һ': 'h', 'ɡ': 'g',
  // Greek lower-case look-alikes.
  'α': 'a', 'β': 'b', 'γ': 'y', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k',
  'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
  'μ': 'u', 'π': 'n', 'ζ': 'z',
  // Latin extended / phonetic forms.
  'ı': 'i', 'ȷ': 'j', 'ɑ': 'a', 'ʟ': 'l', 'ɴ': 'n', 'ʀ': 'r', 'ʏ': 'y',
};

/**
 * Normalise a field name for comparison.
 *
 * Four steps, each closing a different bypass:
 *   1. NFKC folds compatibility forms, so full-width `ｌｅａｒｎｅｒ＿ｉｄ` becomes
 *      `learner_id` instead of collapsing to `id`;
 *   2. lower-casing makes the comparison case-insensitive;
 *   3. look-alike letters fold to ASCII, so a homoglyph spelling cannot pose as
 *      a different field name;
 *   4. every remaining non-alphanumeric character is removed, so all of
 *      `learner_id`, `LEARNER_ID`, `learnerId`, `learner.id` and `learner id`
 *      collapse onto the single token `learnerid`.
 */
export function normalizeFieldName(name: string): string {
  const folded = name.normalize('NFKC').toLowerCase();
  let ascii = '';
  for (const character of folded) {
    ascii += CONFUSABLE_LETTERS[character] ?? character;
  }
  return ascii.replace(/[^a-z0-9]/g, '');
}

/** Every forbidden name, normalised. */
const FORBIDDEN_NORMALIZED: ReadonlySet<string> = new Set(
  [...FORBIDDEN_LEDGER_FIELDS, ...EXTENDED_FORBIDDEN_LEDGER_FIELDS].map(normalizeFieldName),
);

/** True when a field name is forbidden, in any normalisable spelling. */
export function isForbiddenFieldName(name: string): boolean {
  return FORBIDDEN_NORMALIZED.has(normalizeFieldName(name));
}

/**
 * Email address shape. Deliberately permissive about the local part and strict
 * about requiring a dotted domain, because a domain-less string like `a@b` is a
 * handle, not an address.
 */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

/** A run of consecutive digits that could be a national id or a phone number. */
const LONG_DIGITS_PATTERN = /\d{8,}/g;

/** A phone-shaped candidate: digits plus the separators phones actually use. */
const PHONE_CANDIDATE_PATTERN = /\+?\d[\d\s().-]{5,}\d/g;

/** A hex digest (a hash) — not a personal identifier, so digit rules skip it. */
const DIGEST_PATTERN = /^[0-9a-f]{32,}$/i;

/** A compact date, e.g. `20261112` — not a phone number. */
const COMPACT_DATE_PATTERN = /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])$/;

/**
 * A date-like prefix, e.g. `2026-11-12` or `12-11-2026`.
 *
 * Timestamps are everywhere in a ledger payload and must not be mistaken for
 * phone numbers. The two strict forms are used rather than a loose "digits and
 * separators" test, because a separated digit run with a leading zero is a
 * phone number while a date string merely looks like one.
 */
const DATE_LIKE_PATTERNS: readonly RegExp[] = [
  /^(?:19|20)\d{2}[-./]\d{1,2}[-./]\d{1,2}/,
  /^\d{1,2}[-./]\d{1,2}[-./](?:19|20)\d{2}/,
];

function isDateLike(candidate: string): boolean {
  return DATE_LIKE_PATTERNS.some((pattern) => pattern.test(candidate));
}

/** Count the digits in a candidate. */
function digitCount(candidate: string): number {
  let count = 0;
  for (const ch of candidate) {
    if (ch >= '0' && ch <= '9') count += 1;
  }
  return count;
}

/**
 * Value-level personal-data patterns detected in string values.
 *
 * Exported so the sponsor report and any auditor can print the exact rule set
 * that was applied, rather than asking the reader to trust the implementation.
 */
export const VALUE_DETECTION_RULES: readonly string[] = [
  'V1 email-address: a string containing an email-shaped substring (local part, at-sign, domain, dot, top-level domain).',
  'V2 long-digit-string: a string containing 8 or more consecutive digits, unless the run is a compact date (YYYYMMDD) or the whole string is a hex digest of 32+ characters.',
  'V3 phone-shape: a candidate of 9 or more digits joined by space/dash/dot/parenthesis separators that begins with "+" or "0", unless it is date-like.',
  'Numbers are never scanned by V2/V3: money is held as integer minor units, so a large amount legitimately looks like a long digit string. The field-name rule governs money keys.',
];

/**
 * Walk a value tree and collect the paths of forbidden field names.
 *
 * Recursive through nested objects and arrays; the returned paths are stable
 * and human readable, e.g. `meta.items[2].learnerId`.
 */
export function findForbiddenFieldPaths(value: unknown, rootPath = ''): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      const items = node as readonly unknown[];
      for (let i = 0; i < items.length; i += 1) {
        walk(items[i], `${path}[${i}]`);
      }
      return;
    }
    if (node !== null && typeof node === 'object') {
      const source = node as Record<string, unknown>;
      for (const key of Object.keys(source)) {
        const childPath = path === '' ? key : `${path}.${key}`;
        if (isForbiddenFieldName(key)) found.push(childPath);
        walk(source[key], childPath);
      }
    }
  };
  walk(value, rootPath);
  return found;
}

/**
 * Walk a value tree and collect value-level personal data.
 *
 * Only string values are inspected (see the module header for why numbers are
 * exempt).
 */
export function findPersonalDataValues(value: unknown, rootPath = ''): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      const pathLabel = path === '' ? '<root>' : path;
      if (EMAIL_PATTERN.test(node)) {
        found.push(`${pathLabel}: possible email address in value`);
      }
      const isDigest = DIGEST_PATTERN.test(node);
      if (!isDigest) {
        const runs = node.match(LONG_DIGITS_PATTERN);
        if (runs) {
          for (const run of runs) {
            if (COMPACT_DATE_PATTERN.test(run)) continue;
            found.push(`${pathLabel}: long digit string (${run.length} digits) in value`);
          }
        }
        const candidates = node.match(PHONE_CANDIDATE_PATTERN);
        if (candidates) {
          for (const candidate of candidates) {
            if (digitCount(candidate) < 9) continue;
            if (isDateLike(candidate)) continue;
            const startsWithPlus = candidate.startsWith('+');
            const startsWithTrunkZero = candidate.startsWith('0');
            if (!startsWithPlus && !startsWithTrunkZero) continue;
            found.push(`${pathLabel}: phone-shaped value (${digitCount(candidate)} digits)`);
          }
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      const items = node as readonly unknown[];
      for (let i = 0; i < items.length; i += 1) {
        walk(items[i], `${path}[${i}]`);
      }
      return;
    }
    if (node !== null && typeof node === 'object') {
      const source = node as Record<string, unknown>;
      for (const key of Object.keys(source)) {
        walk(source[key], path === '' ? key : `${path}.${key}`);
      }
    }
  };
  walk(value, rootPath);
  return found;
}

/**
 * Assert that a payload carries no personal data.
 *
 * Returns a structured verdict instead of throwing, because the sponsor report
 * uses it as a SELF-CHECK: the report scans its own output and publishes the
 * verdict as part of the artefact. The ledger store uses the same primitives to
 * refuse an append.
 */
export function assertNoPersonalData(payload: unknown): { ok: boolean; violations: string[] } {
  const fieldViolations = findForbiddenFieldPaths(payload).map(
    (path) => `forbidden field name at "${path}"`,
  );
  const valueViolations = findPersonalDataValues(payload);
  const violations = [...fieldViolations, ...valueViolations];
  return { ok: violations.length === 0, violations };
}
