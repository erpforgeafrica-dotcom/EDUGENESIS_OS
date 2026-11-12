/**
 * Static scanners.
 *
 * Three families of rule, all pure functions over file contents so they can
 * be unit tested without touching the filesystem:
 *
 *   1. PII          — personal data hardcoded into source (Doc 2 §2.5).
 *   2. Hex tokens   — raw colour literals outside the token stylesheet.
 *   3. Absolute paths — machine-specific paths that break the portability law.
 *
 * A violation NEVER carries the offending value. The report says where the
 * problem is and what kind of problem it is, not what the secret was.
 */
import type { SourceFile, Violation } from './types.js';

/** An email-shaped run of characters. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** A digit run that could be a phone number; shape is checked separately. */
const PHONE_CANDIDATE_PATTERN = /\+?\d[\d\s().-]{6,18}\d/g;

/** A personal-data field assigned a literal value. */
const NAME_FIELD_PATTERN =
  /\b(?:learner_name|learnerName|guardian_name|guardianName|learner_email|guardian_email|email)\b\s*[:=]\s*(['"`])([^'"`\n]{2,80})\1/g;

/** A raw hex colour: #rgb, #rgba, #rrggbb, #rrggbbaa. */
const HEX_PATTERN = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9A-Za-z_])/g;

/**
 * A functional colour literal. The pieces are joined at runtime so that this
 * source file does not itself contain a colour literal for the scanner to find.
 */
const FUNCTIONAL_COLOUR_PATTERN = new RegExp('\\b(?:rgba|hsla)' + '\\(', 'g');

/**
 * A Windows drive-letter path — a letter, a colon and a backslash.
 *
 * WHY the lookbehind: source code is full of template strings ending in
 * `word:\n` (an error label followed by a newline escape). Without the
 * boundary, the last letter of the word is read as a drive letter and every
 * `throw new Error(\`invalid settings:\n…\`)` becomes a portability finding.
 * A real drive letter is a standalone token: it follows a quote, a space, an
 * `=`, a `(` — never another identifier character.
 */
const DRIVE_LETTER_PATTERN = /(?<![A-Za-z0-9_])[A-Za-z]:\\/g;

/** A UNC network path — two leading backslashes and a host name. */
const UNC_PATTERN = /\\\\[A-Za-z0-9._$-]+\\/g;

/**
 * A literal user-profile segment. Assembled from fragments so this file does
 * not contain the pattern it is looking for.
 */
const USER_PROFILE_PATTERN = new RegExp('\\\\' + 'Users' + '[\\\\/]', 'gi');

/**
 * Documented allowlist for synthetic personal data.
 *
 * A value is considered clearly synthetic when it contains one of these
 * markers. The list is deliberately short and explicit; anything else that
 * looks personal is a finding.
 */
export const ALLOWLISTED_VALUE_MARKERS: readonly string[] = [
  'test-', // test-learner-0001
  'synthetic', // Synthetic Learner — a fixture that announces itself as a fixture
  'example.', // example.com / example.org
  'example.org', // reserved domain, spelled out for clarity
  '+000', // reserved international prefix
  'localhost', // loopback host
];

/** True when the value carries a documented synthetic marker. */
export function isAllowlistedValue(value: string): boolean {
  const lowered = value.toLowerCase();
  return ALLOWLISTED_VALUE_MARKERS.some((marker) => lowered.includes(marker.toLowerCase()));
}

/** True when the digit run looks like a telephone number rather than a number. */
export function isPhoneShaped(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return false;
  // An explicit international prefix is a strong signal.
  if (value.startsWith('+')) return true;
  // Without any separator this is just a long number (an epoch, a byte count).
  if (!/[()\s.-]/.test(value)) return false;
  // A plain decimal number.
  if (/^\d*\.?\d+$/.test(value)) return false;
  // An IPv4 address.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  // Thousands separators are not used in telephone numbers.
  if (value.includes(',')) return false;
  // An ISO date.
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  return true;
}

/** True when the value reads like a personal name (two to four capitalised words). */
export function isNameLike(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 5) return false;
  return /^[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){1,3}$/.test(trimmed);
}

function linesOf(content: string): string[] {
  return content.split(/\r?\n/);
}

/**
 * Find hardcoded personal data.
 */
export function findPiiViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    linesOf(file.content).forEach((text, index) => {
      const line = index + 1;
      for (const match of text.matchAll(EMAIL_PATTERN)) {
        const value = match[0];
        if (value === undefined || isAllowlistedValue(value)) continue;
        out.push({
          kind: 'pii',
          file: file.relPath,
          line,
          rule: 'pii-email',
          detail: 'email-shaped literal hardcoded in source',
        });
      }
      for (const match of text.matchAll(PHONE_CANDIDATE_PATTERN)) {
        const value = match[0];
        if (value === undefined || !isPhoneShaped(value)) continue;
        if (isAllowlistedValue(value)) continue;
        out.push({
          kind: 'pii',
          file: file.relPath,
          line,
          rule: 'pii-phone',
          detail: 'phone-number-shaped digit string hardcoded in source',
        });
      }
      for (const match of text.matchAll(NAME_FIELD_PATTERN)) {
        const value = match[2];
        if (value === undefined || !isNameLike(value)) continue;
        if (isAllowlistedValue(value)) continue;
        out.push({
          kind: 'pii',
          file: file.relPath,
          line,
          rule: 'pii-name',
          detail: 'personal name assigned to a personal-data field',
        });
      }
    });
  }
  return out;
}

/**
 * Find raw colour literals. The token stylesheet is the only place a colour
 * value may live.
 */
export function findHexViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    linesOf(file.content).forEach((text, index) => {
      const line = index + 1;
      for (const _match of text.matchAll(HEX_PATTERN)) {
        out.push({
          kind: 'hex',
          file: file.relPath,
          line,
          rule: 'hex-literal',
          detail: 'raw hex colour literal in source — use a design token',
        });
      }
      for (const _match of text.matchAll(FUNCTIONAL_COLOUR_PATTERN)) {
        out.push({
          kind: 'hex',
          file: file.relPath,
          line,
          rule: 'functional-colour-literal',
          detail: 'functional colour literal in source — use a design token',
        });
      }
    });
  }
  return out;
}

/**
 * Find hardcoded absolute paths. These break the portability law: the project
 * must run on any Windows PC from any folder, under any user name.
 */
export function findAbsolutePathViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    linesOf(file.content).forEach((text, index) => {
      const line = index + 1;
      for (const _match of text.matchAll(DRIVE_LETTER_PATTERN)) {
        out.push({
          kind: 'absolute-path',
          file: file.relPath,
          line,
          rule: 'abs-drive-letter',
          detail: 'hardcoded absolute path with a drive letter',
        });
      }
      for (const _match of text.matchAll(UNC_PATTERN)) {
        out.push({
          kind: 'absolute-path',
          file: file.relPath,
          line,
          rule: 'abs-unc',
          detail: 'hardcoded UNC network path',
        });
      }
      for (const _match of text.matchAll(USER_PROFILE_PATTERN)) {
        out.push({
          kind: 'absolute-path',
          file: file.relPath,
          line,
          rule: 'abs-user-profile',
          detail: 'hardcoded user-profile path segment',
        });
      }
    });
  }
  return out;
}
