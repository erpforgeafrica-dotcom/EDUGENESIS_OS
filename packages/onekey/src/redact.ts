/**
 * Credential redaction.
 *
 * WHY this exists: the gateway records failure reasons into the routing audit
 * trail and the attempt log. A provider error message can carry an
 * authorization header or a key-shaped fragment, and an audit trail is the
 * last place a credential should ever land. Everything that is written into a
 * reason string goes through here first.
 *
 * The package never logs a credential, and never writes one to disk.
 */

/** Field names whose VALUE is a credential whatever its shape. */
const SENSITIVE_FIELD = /^(api[_-]?key|apikey|access[_-]?token|token|secret|password|authorization|credential)$/i;

/** Patterns that look like a credential and must never be persisted. */
const REDACTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // "Bearer <token>" in any header dump.
  { pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}/gi, replacement: '$1 [redacted]' },
  // Vendor-style prefixed keys (sk-..., qwen-..., gsk_...).
  { pattern: /\b(sk|qwen|gsk|dashscope|api)[-_][A-Za-z0-9_-]{8,}/gi, replacement: '[redacted]' },
  // key/token/secret/password assignments in free text, in JSON and in
  // "name=value" form. The optional quote after the name covers JSON keys
  // such as {"token": "..."}.
  {
    pattern:
      /\b(api[_-]?key|apikey|access[_-]?token|token|secret|password|authorization)(["']?\s*[:=]\s*)(["']?)[^\s"',;}]{4,}\3/gi,
    replacement: '$1$2$3[redacted]$3',
  },
];

/**
 * Mask anything in `value` that looks like a credential.
 *
 * Short values are left alone on purpose: masking every 4-character word
 * would destroy the usefulness of an audit trail.
 */
export function redactSecret(value: string): string {
  let out = value;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Redact a value of ANY shape, not just a string (audit finding F3-26).
 *
 * Provider SDKs reject with objects, header maps are objects, and a stack is a
 * string field inside an Error. A string-only redactor walks straight past all
 * of them and lands a credential in the audit trail. This walks the structure:
 * strings are masked, Errors become plain objects whose message and stack are
 * masked, arrays and plain objects are traversed, and primitive leaves are
 * preserved as-is.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecret(value);
  }
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactSecret(value.message),
    };
    for (const [key, field] of Object.entries(value)) {
      out[key] = redactValue(field);
    }
    if (value.stack !== undefined) {
      out.stack = redactSecret(value.stack);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
      // A key such as `token` or `apiKey` is itself evidence that the value is
      // a credential, even when the value has no vendor prefix or assignment
      // syntax for redactSecret() to recognise. Mask the whole field for both
      // string and non-string values; keep the key so the audit trail still
      // says WHERE the secret was found.
      out[key] = SENSITIVE_FIELD.test(key) ? '[redacted]' : redactValue(field);
    }
    return out;
  }
  // Numbers, booleans, null, undefined, symbols and functions carry no secret.
  return value;
}

/** A redacted, string-shaped description of an error of any type. */
export function describeRedacted(value: unknown): string {
  if (typeof value === 'string') {
    return redactSecret(value);
  }
  const redacted = redactValue(value);
  try {
    return JSON.stringify(redacted) ?? String(redacted);
  } catch {
    return String(redacted);
  }
}
