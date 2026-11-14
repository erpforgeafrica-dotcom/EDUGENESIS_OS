/**
 * The delivery-path registry (F6-R4-03).
 *
 * WHY THIS EXISTS
 *   `tools/verify-coverage.mjs` proves that every learner-facing emission is
 *   intercepted by the accessibility guardian exactly once. Its path list used
 *   to be a literal array inside the tool script, so a new learner-facing
 *   delivery path added to the gateway was invisible to the gate (round-4
 *   finding F6-R4-03). The registry is the fix: the path set is declared HERE,
 *   next to the gateway and the ladder it implements, in the same package that
 *   must change when a path is added. The gate imports this registry and runs
 *   every entry; this test file pins each entry's truth.
 *
 * WHAT AN ENTRY IS
 *   `DeliveryPathEntry.name/tier/learnerFacing` are the declaration the gate
 *   enumerates; `build()` returns a FRESH spec (fresh adapters, fresh tier-0
 *   provider) because several paths share the same construction shape and the
 *   tier-0 provider caches per instance — a shared instance would make the
 *   last-resort path serve from the exact-hit cache and silently stop proving
 *   what its name claims.
 *
 * WHY THE DRIVER LIVES HERE
 *   `runDeliveryPath` is the single driver for a spec: the gate, the tool and
 *   this test all use it. A second implementation would prove nothing (the
 *   same rule the secrets scanner's canary follows).
 *
 * THE LADDER (Doc 16 §6.4)
 *   Tiers come from `FALLBACK_TIER_ROLE` in `@edugenesis/contracts` — the
 *   single source of truth for the ladder. `registryTierCoverage` refuses a
 *   registry that stops covering any rung, so removing a tier's only path is
 *   a loud failure, not a silent coverage drop.
 */
import type { FallbackTier, ProviderAdapter } from '@edugenesis/contracts';
import { FALLBACK_TIER_ROLE, ProviderUnavailableError } from '@edugenesis/contracts';

import { createAccessibilityGuardian, createAccessibilityValidator } from '@edugenesis/accessibility';

import { createOneKeyGateway, type GatewayOptions } from '../gateway.js';
import { createTierZeroProvider } from '../providers/tier-zero.js';
import {
  createContext,
  createMockAdapter,
  createPolicy,
  createRequest,
} from './support.js';

/** A prompt the offline curriculum bundle answers exactly. */
const OFFLINE_PROMPT = 'Explain curriculum:algebra/linear-eq';
/** A prompt the offline bundle has no exact entry for. */
const LIVE_PROMPT = 'Explain photosynthesis in simple terms';

/** One fully-constructed delivery path, ready to be driven. */
export interface DeliveryPathSpec {
  name: string;
  /** The ladder rung this path proves the gateway can serve. */
  tier: FallbackTier;
  learnerFacing: boolean;
  prompt: string;
  gatewayOptions: GatewayOptions;
  adapters: ProviderAdapter[];
}

/** One declared delivery path; `build()` yields a fresh spec per drive. */
export interface DeliveryPathEntry {
  name: string;
  tier: FallbackTier;
  learnerFacing: boolean;
  build(): DeliveryPathSpec;
}

/** How one drive ended, as the gate and the tests read it. */
export interface DeliveryPathRun {
  name: string;
  declaredTier: FallbackTier;
  learnerFacing: boolean;
  delivered: boolean;
  /** The tier the gateway reports in `meta.tier`, or null when nothing delivered. */
  servedTier: FallbackTier | null;
  bytes: number;
  interceptions: number;
  failure: string | null;
}

/**
 * Drive one spec end to end through a REAL gateway with the REAL guardian,
 * counting every entry into the guardian. Pure to the spec: nothing leaks
 * between drives because every adapter and the tier-0 provider are fresh.
 */
export async function runDeliveryPath(spec: DeliveryPathSpec): Promise<DeliveryPathRun> {
  const real = createAccessibilityGuardian(createAccessibilityValidator());
  const sink = { interceptions: 0 };
  const guardian = {
    async intercept(
      emission: Parameters<typeof real.intercept>[0],
      ctx: Parameters<typeof real.intercept>[1],
    ) {
      sink.interceptions += 1;
      return real.intercept(emission, ctx);
    },
  };

  const gateway = createOneKeyGateway(spec.gatewayOptions);
  for (const adapter of spec.adapters) gateway.register(adapter);

  const ctx = createContext({ learnerFacing: spec.learnerFacing, guardian });
  const request = createRequest({ prompt: spec.prompt });

  let delivered = false;
  let servedTier: FallbackTier | null = null;
  let bytes = 0;
  let failure: string | null = null;
  try {
    const result = await gateway.complete(createPolicy(), request, ctx);
    delivered = true;
    servedTier = result.meta.tier;
    bytes = result.text.length;
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  return {
    name: spec.name,
    declaredTier: spec.tier,
    learnerFacing: spec.learnerFacing,
    delivered,
    servedTier,
    bytes,
    interceptions: sink.interceptions,
    failure,
  };
}

/** Every rung of the fallback ladder, in ascending order, from the contracts. */
export const LADDER_TIERS: readonly FallbackTier[] = (
  Object.keys(FALLBACK_TIER_ROLE)
    .map((tier) => Number(tier) as FallbackTier)
    .sort((a, b) => a - b)
);

/** Every rung NOT covered by at least one learner-facing entry of the registry. */
export function registryTierCoverage(
  entries: readonly DeliveryPathEntry[],
): { missing: FallbackTier[] } {
  const covered = new Set<FallbackTier>();
  for (const entry of entries) {
    if (entry.learnerFacing) covered.add(entry.tier);
  }
  return { missing: LADDER_TIERS.filter((tier) => !covered.has(tier)) };
}

/** The learner-facing entries only (the paths the guardian must guard). */
export function learnerEntries(
  entries: readonly DeliveryPathEntry[],
): readonly DeliveryPathEntry[] {
  return entries.filter((entry) => entry.learnerFacing);
}

/** A provider that fails every request, for driving the ladder downwards. */
function failing(id: string, tier: 1 | 2 | 3): ProviderAdapter {
  return createMockAdapter({
    id,
    tier,
    failWith: new ProviderUnavailableError(id, 'simulated outage'),
  }).adapter;
}

/**
 * THE REGISTRY.
 *
 * Six learner-facing paths — every shape of delivery the ladder can produce —
 * plus one operator control that must never be intercepted. A new
 * learner-facing delivery path MUST be added here in the same change that
 * adds it to the gateway; a path that claims a tier it does not serve is
 * caught by the registry test and then by the gate.
 */
export const DELIVERY_PATHS: readonly DeliveryPathEntry[] = [
  {
    name: 'tier-0-exact',
    tier: 0,
    learnerFacing: true,
    build: () => ({
      name: 'tier-0-exact',
      tier: 0,
      learnerFacing: true,
      prompt: OFFLINE_PROMPT,
      gatewayOptions: { tierZero: createTierZeroProvider() },
      adapters: [],
    }),
  },
  {
    name: 'tier-1-primary',
    tier: 1,
    learnerFacing: true,
    build: () => ({
      name: 'tier-1-primary',
      tier: 1,
      learnerFacing: true,
      prompt: LIVE_PROMPT,
      gatewayOptions: { tierZero: createTierZeroProvider() },
      adapters: [createMockAdapter({ id: 'p1', tier: 1 }).adapter],
    }),
  },
  {
    name: 'tier-2-fallback',
    tier: 2,
    learnerFacing: true,
    build: () => ({
      name: 'tier-2-fallback',
      tier: 2,
      learnerFacing: true,
      prompt: LIVE_PROMPT,
      gatewayOptions: { tierZero: createTierZeroProvider() },
      adapters: [failing('p1', 1), createMockAdapter({ id: 'p2', tier: 2 }).adapter],
    }),
  },
  {
    name: 'tier-3-local',
    tier: 3,
    learnerFacing: true,
    build: () => ({
      name: 'tier-3-local',
      tier: 3,
      learnerFacing: true,
      prompt: LIVE_PROMPT,
      gatewayOptions: { tierZero: createTierZeroProvider() },
      adapters: [
        failing('p1', 1),
        failing('p2', 2),
        createMockAdapter({ id: 'p3', tier: 3 }).adapter,
      ],
    }),
  },
  {
    name: 'tier-0-last-resort',
    tier: 0,
    learnerFacing: true,
    build: () => ({
      name: 'tier-0-last-resort',
      tier: 0,
      learnerFacing: true,
      prompt: LIVE_PROMPT,
      gatewayOptions: { tierZero: createTierZeroProvider() },
      adapters: [failing('p1', 1), failing('p2', 2), failing('p3', 3)],
    }),
  },
  {
    name: 'tier-4-human-deferral',
    tier: 4,
    learnerFacing: true,
    build: () => ({
      name: 'tier-4-human-deferral',
      tier: 4,
      learnerFacing: true,
      prompt: LIVE_PROMPT,
      gatewayOptions: {
        // No offline tier, so the ladder must reach the human rung.
        tierFour: {
          async serve() {
            return {
              text: 'A human tutor will reply within one working day.',
              providerId: 'tier-four',
              modelId: 'human-support',
              usage: { inputTokens: 0, outputTokens: 0 },
              latencyMs: 0,
              sourceLineage: [],
            };
          },
        },
      },
      adapters: [failing('p1', 1), failing('p2', 2), failing('p3', 3)],
    }),
  },
  {
    // The negative control: an operator path, where the guardian is not
    // applicable by design. If this reports an interception, the counter is
    // counting requests and the coverage figure is meaningless.
    name: 'operator-not-learner-facing',
    tier: 1,
    learnerFacing: false,
    build: () => ({
      name: 'operator-not-learner-facing',
      tier: 1,
      learnerFacing: false,
      prompt: LIVE_PROMPT,
      gatewayOptions: { tierZero: createTierZeroProvider() },
      adapters: [createMockAdapter({ id: 'p1', tier: 1 }).adapter],
    }),
  },
];
