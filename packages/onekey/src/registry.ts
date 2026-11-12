import type { FallbackTier, ProviderAdapter, ProviderCapabilities } from '@edugenesis/contracts';

/**
 * The provider registry (Doc 2 ADR-0001).
 *
 * WHY a registry at all: "a provider change is a registry change — no
 * learner-path code may import a provider SDK". Swapping Alibaba for another
 * hosted model is a registry edit, not a code change in the tutoring path.
 * src/registry.test.ts enforces that mechanically.
 */
export type ProviderStatus = 'active' | 'disabled';

/** One row of the model registry. */
export interface ModelRegistryEntry {
  /** Stable provider id (matches ProviderAdapter.id). */
  providerId: string;
  /** Model this provider serves. */
  modelId: string;
  /** Fallback tier of the model (1 primary hosted, 2 secondary hosted, 3 local/open). */
  tier: FallbackTier;
  /** What the provider can do and what it is cleared for. */
  capabilities: ProviderCapabilities;
  /** Registry-level enable/disable, independent of the kill switch. */
  status: ProviderStatus;
  /** BCP-47 locales this model serves. `*` means "declares no locale limit". */
  locales: string[];
  /**
   * Sponsor preference, recorded but NEVER used for routing.
   *
   * WHY it exists: Doc 16 §6.4 requires that the routing decision is made from
   * policy, never from sponsor preference. Keeping the flag in the registry
   * makes that auditable — the field is inert by construction, and
   * src/policy.test.ts proves a sponsor-preferred provider does not win.
   */
  sponsorPreferred: boolean;
  /** The adapter itself, so the registry is the single source of truth. */
  adapter: ProviderAdapter;
}

export interface RegisterMeta {
  /** Locales the model serves. Defaults to `['*']` (no locale restriction). */
  locales?: string[];
  /** Initial status. Defaults to 'active'. */
  status?: ProviderStatus;
  /** Recorded for audit, ignored by routing. Defaults to false. */
  sponsorPreferred?: boolean;
}

export interface ProviderRegistry {
  register(adapter: ProviderAdapter, meta?: RegisterMeta): void;
  unregister(providerId: string): void;
  listProviders(): ProviderAdapter[];
  get(providerId: string): ModelRegistryEntry | undefined;
  entries(): ModelRegistryEntry[];
  setStatus(providerId: string, status: ProviderStatus): void;
}

export function createProviderRegistry(): ProviderRegistry {
  const entries = new Map<string, ModelRegistryEntry>();

  return {
    register(adapter: ProviderAdapter, meta: RegisterMeta = {}): void {
      // Capabilities are snapshotted at registration so the registry stays
      // inspectable even if an adapter is mid-restart.
      const capabilities = adapter.capabilities();
      entries.set(adapter.id, {
        providerId: adapter.id,
        modelId: adapter.modelId,
        tier: adapter.tier,
        capabilities,
        status: meta.status ?? 'active',
        locales: meta.locales ?? ['*'],
        sponsorPreferred: meta.sponsorPreferred ?? false,
        adapter,
      });
    },
    unregister(providerId: string): void {
      entries.delete(providerId);
    },
    listProviders(): ProviderAdapter[] {
      return [...entries.values()].map((entry) => entry.adapter);
    },
    get(providerId: string): ModelRegistryEntry | undefined {
      return entries.get(providerId);
    },
    entries(): ModelRegistryEntry[] {
      return [...entries.values()];
    },
    setStatus(providerId: string, status: ProviderStatus): void {
      const entry = entries.get(providerId);
      if (entry) {
        entry.status = status;
      }
    },
  };
}
