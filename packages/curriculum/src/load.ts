import type { ValidationResult } from './pack.js';
import { validatePack } from './validate.js';

/**
 * Strictly parse JSON text and validate it as a curriculum pack.
 *
 * Malformed JSON is reported as an issue with an explicit path so callers get
 * the same `{ ok, issues }` shape whether the failure is syntactic or semantic.
 */
export function loadPack(json: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issues: [{ path: 'json', message: `malformed JSON: ${message}` }],
    };
  }
  return validatePack(parsed);
}
