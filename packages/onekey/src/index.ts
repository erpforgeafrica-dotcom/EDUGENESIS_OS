/**
 * The OneKey package — public surface.
 *
 * Everything a deployment needs to route a request across providers, enforce
 * a budget, break a circuit, pull a provider, and prove the whole ladder
 * works offline.
 *
 * Governance:
 *   Doc 2 §7  — provider adapter, OneKey routing, ADR-0001
 *   Doc 6 §5  — the kill switch
 *   Doc 6 §7.3 — the accessibility guardian interception point
 *   Doc 16 §3.6, §4.2 — budget ledger, hard cap, no overage
 *   Doc 16 §6.4 — the five-tier fallback ladder and model sovereignty
 */

export * from './budget.js';
export * from './circuit-breaker.js';
export * from './kill-switch.js';
export * from './provider-errors.js';
export * from './provider-wiring.js';
export * from './registry.js';
export * from './registry/model-card.js';
export * from './registry/regions.js';
export * from './registry/signed-bundle.js';
export * from './registry/tier-two-adapter.js';
export * from './policy.js';
export * from './gateway.js';
export * from './conformance.js';
export * from './egress.js';
export * from './failover.js';
export * from './redact.js';
export * from './tier-zero-fallback.js';
// Concrete ADAPTERS stay behind their own modules. The root surface is
// provider-agnostic: a change of hosted provider is a registry change, so the
// concrete Qwen adapter is intentionally NOT re-exported here (F3-34). Its
// FetchLike TYPE is re-exported because the CLI's injection seam depends on it;
// a type is not a provider dependency and does not leak the adapter.
export type { FetchLike } from './providers/qwen-adapter.js';
export * from './providers/local-echo.js';
export * from './providers/tier-zero.js';
