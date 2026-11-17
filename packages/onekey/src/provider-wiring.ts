/**
 * Provider-neutral wiring for the application seam (ADR-0001).
 *
 * A provider change must be a registry change, with no provider name in
 * learner-path code outside this package. This module owns the one mapping
 * from a settings provider id to the adapter factory that serves it; the CLI
 * calls `wireConfiguredProvider` and never names a provider or imports an
 * adapter implementation. Add a hosted provider here, not in the application.
 */

import type { ProviderAdapter } from '@edugenesis/contracts';

import {
  type FetchLike,
  QWEN_BASE_URL,
  QWEN_DEFAULT_MODEL,
  createQwenAdapter,
} from './providers/qwen-adapter.js';

/** The provider id hosted adapters in this build are registered under. */
export const HOSTED_PROVIDER_ID = 'qwen';

/** Neutral aliases for the tests and application: provider facts stay inside this package. */
export const HOSTED_BASE_URL = QWEN_BASE_URL;
export const HOSTED_MODEL_ID = QWEN_DEFAULT_MODEL;

/** The settings slice the wiring reads. */
export interface ProviderConfiguration {
  readonly primary: string;
  readonly apiKeys: Readonly<Record<string, string>>;
}

type AdapterFactory = (options: {
  apiKey: string;
  fetchImpl?: FetchLike;
}) => ProviderAdapter;

/** THE REGISTRY: one row per hosted provider this build can reach. */
const HOSTED_ADAPTERS: Readonly<Record<string, AdapterFactory>> = {
  [HOSTED_PROVIDER_ID]: createQwenAdapter,
};

/**
 * Resolve the settings' primary provider to a registered adapter.
 *
 * A missing or empty key is NOT an error: undefined means the route runs on
 * tier 0 alone. A key named for a DIFFERENT provider is never used — it must
 * never travel to a host it does not belong to. The key stays in this call
 * frame: it is handed to the adapter's closure and is never logged, echoed or
 * written to a record.
 */
export function wireConfiguredProvider(
  config: ProviderConfiguration,
  fetchImpl?: FetchLike,
): ProviderAdapter | undefined {
  const factory = HOSTED_ADAPTERS[config.primary];
  if (factory === undefined) return undefined;
  const apiKey = config.apiKeys[config.primary];
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) return undefined;
  return factory(fetchImpl === undefined ? { apiKey } : { apiKey, fetchImpl });
}
