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
