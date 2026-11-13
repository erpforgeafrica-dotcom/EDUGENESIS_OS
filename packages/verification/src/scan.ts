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
 * A Windows drive-letter path — a letter, a colon and a separator.
 *
 * Both separators count. The round-4 audit caught the original
 * backslash-only class: the forward-slash spelling of a drive-letter profile
 * path walked straight through a gate that claimed to police absolute paths,
 * so the forward-slash spelling is a real hole, not a stylistic variant.
 *
 * WHY the lookbehind: source code is full of template strings ending in
 * `word:\n` (an error label followed by a newline escape). Without the
 * boundary, the last letter of the word is read as a drive letter and every
 * `throw new Error(\`invalid settings:\n…\`)` becomes a portability finding.
 * A real drive letter is a standalone token: it follows a quote, a space, an
 * `=`, a `(` — never another identifier character.
 */
const DRIVE_LETTER_PATTERN = /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/g;

/**
 * A UNC network path written the Windows way — two backslashes and a host.
 *
 * The host token must be at least two characters and start with an
 * alphanumeric. WHY: `\\n\` is an escaped newline in prose and `\\.\` is the
 * Windows device namespace; neither is a network share, and both appear inside
 * legitimate documentation and JSON schema patterns. A real UNC host is never
 * a single punctuation character.
 */
const UNC_PATTERN = /\\\\[A-Za-z0-9_$][A-Za-z0-9._$-]+[\\/]/g;

/**
 * A UNC network path written with forward slashes — two leading slashes and
 * a share host.
 *
 * The host must carry no dot, because the protocol-relative form of a URL
 * (two slashes, a dotted domain, a slash) would turn every documentation link
 * into a finding. A NetBIOS-style share host does not contain a dot.
 */
const UNC_POSIX_PATTERN = /(?<![:A-Za-z0-9_.\\/])\/\/[A-Za-z0-9_$-]+\/[A-Za-z0-9_$]/g;

/**
 * A literal user-profile segment, in either separator style. Assembled from
 * fragments so this file does not contain the pattern it is looking for.
 */
const USER_PROFILE_PATTERN = new RegExp(
  '(?<![A-Za-z0-9_])[\\\\/]' + 'Users' + '[\\\\/]',
  'gi',
);

/**
 * A POSIX home-directory segment, in either separator style. The audited
 * hole was the forward-slash home spelling: a build-machine home path is
 * exactly as unportable as a drive letter, and only the Windows spelling was
 * policed.
 */
const HOME_PROFILE_PATTERN = new RegExp(
  '(?<![A-Za-z0-9_])[\\\\/]' + 'home' + '[\\\\/]',
  'gi',
);

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
 * Remove comments from a source file, preserving line structure.
 *
 * WHY: a provider name in a citation or a doc comment is not a provider
 * dependency. A provider HOST or SDK in executable code is. Stripping comments
 * lets a gate scan every package — including `packages/contracts`, whose header
 * cites the sponsor document by name — without excluding a package or
 * weakening the rule. Newlines are preserved so reported line numbers stay
 * true, and string literals are NOT stripped: a provider host inside a string
 * is executable and must still be caught.
 *
 * A `//` is only treated as a comment when it follows whitespace or the start
 * of the file, so a regex literal such as `/\/\//` is not mistaken for one.
 */
export function stripComments(content: string): string {
  let out = '';
  let index = 0;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let previous = '';

  while (index < content.length) {
    const char = content[index] ?? '';
    const next = content[index + 1];

    if (state === 'code') {
      const startsComment =
        char === '/' && (next === '/' || next === '*') && (previous === '' || /\s/.test(previous));
      if (startsComment) {
        state = next === '/' ? 'line' : 'block';
        out += '  ';
        index += 2;
        continue;
      }
      if (char === "'") state = 'single';
      else if (char === '"') state = 'double';
      else if (char === '`') state = 'template';
      out += char;
      previous = char;
      index += 1;
      continue;
    }

    if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        out += char;
        previous = '';
      } else {
        out += ' ';
      }
      index += 1;
      continue;
    }

    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        out += '  ';
        index += 2;
        continue;
      }
      out += char === '\n' ? '\n' : ' ';
      index += 1;
      continue;
    }

    // Inside a string literal: copy verbatim, honouring escapes.
    if (char === '\\') {
      out += char;
      if (next !== undefined) {
        out += next;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    const closes =
      (state === 'single' && char === "'") ||
      (state === 'double' && char === '"') ||
      (state === 'template' && char === '`');
    if (closes) state = 'code';
    out += char;
    previous = char;
    index += 1;
  }

  return out;
}

/**
 * Remove SVG path geometry from a file's content before it is scanned.
 *
 * WHY: an SVG path is a list of coordinates — "M256 316" and curve parameters
 * like "-30-20-66" — and a long dash-separated run of digits is
 * indistinguishable from a telephone number to a digit-run rule. The geometry
 * is not data and cannot carry personal data, so it is taken out of scope for
 * the scan.
 *
 * ONLY the `d` attribute is removed. A `<text>` element is content, and it
 * stays in scope: an SVG that displayed a learner's name would still be
 * caught.
 */
function stripSvgGeometry(content: string): string {
  return content.replace(/\sd="[^"]*"/g, ' d=""');
}

/**
 * Find hardcoded personal data.
 */
export function findPiiViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    const content = file.relPath.toLowerCase().endsWith('.svg')
      ? stripSvgGeometry(file.content)
      : file.content;
    linesOf(content).forEach((text, index) => {
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
/**
 * The colour values a token stylesheet defines, upper-cased for comparison.
 */
export function extractTokenColours(stylesheet: string): ReadonlySet<string> {
  const values = new Set<string>();
  for (const match of stylesheet.matchAll(HEX_PATTERN)) {
    const value = match[0];
    if (value !== undefined) values.add(value.toUpperCase());
  }
  return values;
}

export interface HexScanOptions {
  /**
   * Project-relative path of the token stylesheet — the source of truth. Its
   * own literals are not findings; they are the definitions everything else
   * must agree with.
   */
  readonly tokenStylesheet: string;
  /** The colour values the token stylesheet defines. */
  readonly tokenColours: ReadonlySet<string>;
  /**
   * Files whose format cannot reference a CSS custom property. A literal in
   * one of these is a finding UNLESS its value is a token colour.
   */
  readonly valueAssetFiles: readonly string[];
}

/**
 * Find raw colour literals.
 *
 * Two rules, not one:
 *
 *   1. In ordinary source, a colour is written as `var(--eg-…)`. A literal is
 *      a finding even when its value happens to match a token: the point of
 *      the rule is that the component READS the token, so a theme switch
 *      reaches it.
 *
 *   2. A few shipped formats cannot express a variable — the web app
 *      manifest, an SVG loaded as an image, and the `theme-color` meta
 *      element. In those files a literal is unavoidable, so it is allowed
 *      ONLY when the value is one the token stylesheet defines. The exemption
 *      is therefore checked, not assumed: a colour that drifts from the
 *      tokens is still a finding.
 */
export function findHexViolations(files: readonly SourceFile[], options?: HexScanOptions): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    if (options && file.relPath === options.tokenStylesheet) continue;
    const isValueAsset = options ? options.valueAssetFiles.includes(file.relPath) : false;
    linesOf(file.content).forEach((text, index) => {
      const line = index + 1;
      for (const match of text.matchAll(HEX_PATTERN)) {
        const value = match[0] ?? '';
        if (isValueAsset && options && options.tokenColours.has(value.toUpperCase())) continue;
        out.push({
          kind: 'hex',
          file: file.relPath,
          line,
          rule: 'hex-literal',
          detail: isValueAsset
            ? `raw hex colour literal "${value}" that is not a design token value — an asset colour must equal a token colour`
            : 'raw hex colour literal in source — use a design token',
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
      for (const _match of text.matchAll(UNC_POSIX_PATTERN)) {
        out.push({
          kind: 'absolute-path',
          file: file.relPath,
          line,
          rule: 'abs-unc-posix',
          detail: 'hardcoded UNC network path with forward slashes',
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
      for (const _match of text.matchAll(HOME_PROFILE_PATTERN)) {
        out.push({
          kind: 'absolute-path',
          file: file.relPath,
          line,
          rule: 'abs-home-profile',
          detail: 'hardcoded POSIX home-directory path segment',
        });
      }
    });
  }
  return out;
}
