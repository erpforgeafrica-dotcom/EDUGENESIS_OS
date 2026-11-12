/**
 * EduGenesis OS — shared contracts.
 *
 * THIS FILE IS THE SWARM CONTRACT. It is frozen before any implementation agent
 * starts. Implementation agents may import from here and may NOT edit it without
 * Solo's sign-off, so that five agents can work in parallel against one interface.
 *
 * Authority:
 *   Doc 1 v1.2  — Master Requirements and Governance Charter (single source of truth)
 *   Doc 2 v1.0  — Technical Architecture, AI Safety and Engineering Specification
 *   Doc 6 v1.0  — AI Safety Red-Team Framework, Model Risk Register, Incident Response
 *   Doc 7 v1.0  — Pilot Evaluation Protocol, Independent Audit Plan, Public Impact Reporting
 *   Doc 15 v1.1 — AI Main Tutoring, Adaptive Learning Assistance, Occasional Human Enrichment
 *   Doc 16 v1.0 — Alibaba / China AI Sponsorship, Anchor Sponsor Framework, Model Sovereignty
 *   02_DESIGN_SYSTEM.md   — Aurora design system (tokens, type scale, contrast ledger)
 *   07_DISABILITY_INCLUSION_PLAN.md — nine-element contract + ARC-I1..I12 invariants
 *   08_UX_PLAN_AND_OPTIMIZATION.md  — IA, journeys, screen specs, optimisation budget
 *   09_TECHNICAL_ARCHITECTURE_AI_BRAIN_AND_DEPLOYMENT.md — phases, ADR set, NFRs
 */

// ===========================================================================
// 1. PRIMITIVES
// ===========================================================================

/** AI risk tier (Doc 6 §3.1). 0 = lowest, 4 = highest. */
export type RiskTier = 0 | 1 | 2 | 3 | 4;

/** Data classification (Doc 2 §27). Governs where a payload may travel. */
export type DataClass =
  | 'public'            // curriculum, licensed, no learner linkage
  | 'learner_scoped'    // pseudonymous, per-session, minimised
  | 'sensitive'         // disability, health, safeguarding — never leaves the private store
  | 'secret';           // credentials, keys — never leaves the process

/** Safety tier of a request, independent of the learner's content risk. */
export type SafetyTier = 'low' | 'medium' | 'high' | 'critical';

/**
 * Fallback tier (Doc 16 §6.4). This is the ladder that keeps a learner learning
 * when a provider is unavailable, and it is the promise made to the Anchor Sponsor.
 */
export type FallbackTier = 0 | 1 | 2 | 3 | 4;

export const FALLBACK_TIER_ROLE: Record<FallbackTier, string> = {
  0: 'Cached curriculum and deterministic learning tools (no model provider required)',
  1: 'Primary approved hosted model',
  2: 'Secondary approved hosted model',
  3: 'Local or open model',
  4: 'Human support or deferred response',
};

/** BCP-47-ish language descriptor. */
export interface LanguageInfo {
  /** BCP-47 tag, e.g. "en", "en-KE", "zh-Hans". */
  primary: string;
  /** Additional languages the emission is usable in. */
  support?: string[];
  /** Plain-language variant produced? */
  plainLanguageVariant?: boolean;
}

/** Reading level descriptor (Doc 15 §18.3). */
export interface ReadingLevel {
  /** CEFR-like band or an explicit internal band. */
  band: string;
  /** Words per sentence target used to build the emission. */
  targetWordsPerSentence?: number;
  /** Was the emission simplified for the learner profile? */
  simplified?: boolean;
}

/** Sensory profile the emission was actually produced for. */
export interface SensoryProfile {
  /** Non-visual alternative exists. */
  hasNonVisual: boolean;
  /** Non-audio alternative exists. */
  hasNonAudio: boolean;
  /** Non-motor interaction path exists. */
  hasNonMotor: boolean;
  /** Reduced-motion-safe content. */
  reducedMotionSafe: boolean;
  /** Captioned / transcribed. */
  captioned?: boolean;
  transcribed?: boolean;
}

/** Interaction modes the emission supports. */
export interface InteractionMode {
  input: Array<'keyboard' | 'pointer' | 'voice' | 'switch' | 'touch'>;
  output: Array<'visual' | 'audio' | 'text' | 'tactile'>;
}

/** A single attributable source for an emission. */
export interface SourceLineage {
  /** Stable identifier of the source. */
  sourceId: string;
  /** Locator (URL, skill-atom id, curriculum path). */
  locator: string;
  /** Licence identifier — the Licence Clearance Service gates on this. */
  licence: string;
  /** ISO-8601 retrieval timestamp. */
  retrievedAt: string;
  /** Which tier of evidence this supports (1 = primary, 2 = supporting). */
  tier: 1 | 2;
}

// ===========================================================================
// 2. ACCESSIBILITY RUNTIME CONTRACT (Doc 2 §2.3; 07 §5)
// ===========================================================================

/**
 * The nine-element emission. Doc 2 §2.3: "Accessibility is not a post-processing
 * layer. It is a runtime contract." Every service that produces learner-facing
 * output emits exactly this shape.
 */
export interface AccessibilityEmission {
  /** 1. Canonical content. */
  canonical_content: CanonicalContent;
  /** 2. Accessible alternative. Required for every learner-facing emission. */
  accessible_alternative: AccessibleAlternative;
  /** 3. Metadata. */
  metadata: EmissionMetadata;
  /** 4. Source lineage. Non-empty when risk_tier >= 2. */
  source_lineage: SourceLineage[];
  /** 5. Risk tier. */
  risk_tier: RiskTier;
  /** 6. Language. */
  language: LanguageInfo;
  /** 7. Reading level. */
  reading_level: ReadingLevel;
  /** 8. Sensory profile. */
  sensory_profile: SensoryProfile;
  /** 9. Interaction mode. */
  interaction_mode: InteractionMode;

  // ---- companion fields referenced by the ARC invariants ----
  /** ARC-I1. Set true only when an accessible equivalent has been verified. */
  equivalence_verified: boolean;
  /** ARC-I8. A withheld emission must never be delivered. */
  withheld?: boolean;
  /** ARC-I4. Uncertainty marker, required below the confidence threshold. */
  uncertainty_note?: string | null;
  /** Confidence in the answer, 0..1. */
  confidence_score?: number;
  /** ARC-I12. Set when derived from a learner's accessibility profile. */
  special_category_flag?: boolean;
  /** Gate outcome for a learner with an accessibility profile. ARC-I11. */
  validation?: { gate: 'approved' | 'blocked' | 'pending'; reason?: string };
}

/**
 * Every modality the AI Main Tutor / Multimodal Delivery Engine can emit
 * (Doc 15 §1.1, §7). Each requires an accessible equivalent or it is withheld.
 */
export type Modality =
  | 'text' | 'whiteboard' | 'video' | '3d' | 'diagram' | 'quiz'
  | 'song_story' | 'game' | 'simulation' | 'code' | 'exam';

/** The 3. Metadata element of the nine-element contract. */
export interface EmissionMetadata {
  /** Version of the contract the emitter wrote against. */
  contractVersion: string;
  /** The service that produced the emission. */
  emittingService: string;
  /** The agent that produced it, if any. */
  emittingAgent?: string;
  /** The model that produced it, if any. */
  emittingModel?: string;
  /** ISO-8601 emission time. */
  emittedAt: string;
  /** ARC-I9: hash of the canonical content bytes — tamper and drift check. */
  content_hash: string;
  /** The task class this emission serves. */
  taskClass: TaskClass;
  /** Total media bytes, for the delivery budget check. */
  media_bytes_total?: number;
}

export interface CanonicalContent {
  /** Stable content id. */
  contentId: string;
  /** Human-usable body. */
  body: string;
  /** Modality of the canonical form. */
  modality: Modality;
  /** Structured payload for non-text modalities. */
  payload?: Record<string, unknown>;
  /** Total media size in bytes — ARC-I10 checks this against the delivery budget. */
  media_bytes_total?: number;
}

export interface AccessibleAlternative {
  /** Text path — always present for a learner-facing emission. */
  text?: string;
  /** Audio path. */
  audio?: { transcript: string; description?: string; durationSec?: number };
  /** Visual path for an audio-first emission. */
  visual?: { description: string; dataUri?: string };
  /** Motor-independent interaction path. */
  interactiveAlternative?: { description: string; steps: string[] };
  /** Which dimensions this alternative covers. */
  covers: Array<'visual' | 'auditory' | 'motor'>;
  /** How the equivalence was established. */
  method: 'auto' | 'expert' | 'user-tested';
}

/**
 * The 12 CI invariants (07 §5.3). A Blocker severity fails the build and blocks
 * delivery. High severity fails the build but does not block a non-learner-facing
 * emission.
 */
export type ArcInvariantId =
  | 'ARC-I1' | 'ARC-I2' | 'ARC-I3' | 'ARC-I4' | 'ARC-I5' | 'ARC-I6'
  | 'ARC-I7' | 'ARC-I8' | 'ARC-I9' | 'ARC-I10' | 'ARC-I11' | 'ARC-I12';

export type ArcSeverity = 'Blocker' | 'High';

export interface ArcViolation {
  id: ArcInvariantId;
  severity: ArcSeverity;
  message: string;
  /** Where the failure was found. */
  path: string;
}

export interface ArcValidationResult {
  ok: boolean;
  violations: ArcViolation[];
  /** Invariant ids that passed. */
  passed: ArcInvariantId[];
}

/** The validator implementation contract (packages/accessibility). */
export interface AccessibilityValidator {
  /** Validate one emission against the ARC invariant set. */
  validate(emission: AccessibilityEmission, ctx?: ValidationContext): ArcValidationResult;
  /** Validate a batch; returns one result per emission, in order. */
  validateMany(emissions: AccessibilityEmission[], ctx?: ValidationContext): ArcValidationResult[];
}

export interface ValidationContext {
  /** BCP-47 tag of the learner's locale, if known. */
  locale?: string;
  /** Maximum media bytes allowed for the active delivery mode. */
  mediaBudgetBytes?: number;
  /** The learner's accessibility profile exists (triggers ARC-I11). */
  hasAccessibilityProfile?: boolean;
  /** Confidence below which uncertainty_note is mandatory. */
  confidenceThreshold?: number;
  /** Task safety tier — a critical task may escalate rather than deliver. */
  safetyTier?: SafetyTier;
}

/**
 * The Accessibility Guardian interception point (Doc 6 §7.3). Every learner-facing
 * emission passes through this before delivery. No learner-facing output bypasses it.
 */
export interface AccessibilityGuardian {
  /** Validate and, if valid, return the emission to deliver. */
  intercept(emission: AccessibilityEmission, ctx?: ValidationContext): Promise<{
    deliver: boolean;
    emission?: AccessibilityEmission;
    violations: ArcViolation[];
  }>;
}

// ===========================================================================
// 3. PROVIDER ADAPTER + ONEKEY ROUTING (Doc 2 §7; Doc 16 §6)
// ===========================================================================

/** A provider-agnostic completion request. */
export interface CompletionRequest {
  /** Instruction text for the model. */
  prompt: string;
  /** System/role instruction. */
  system?: string;
  /** Grounded context that the model must ground in. */
  context?: Array<{ source: SourceLineage; text: string }>;
  /** Data class of the whole request — the highest class of any part. */
  dataClass: DataClass;
  /** Safety tier of the task. */
  safetyTier: SafetyTier;
  /** Learner accessibility profile hash (never the profile itself). */
  accessibilityProfileHash?: string;
  /** BCP-47 locale. */
  locale?: string;
  /** Hard ceiling on tokens this request may consume. */
  maxOutputTokens: number;
  /** Whether the emission must satisfy the accessibility contract. */
  requiresAccessibilityContract: boolean;
}

export interface CompletionResult {
  /** Model output text. */
  text: string;
  /** Provider that served it. */
  providerId: string;
  modelId: string;
  /** Tokens consumed, for the budget ledger. */
  usage: { inputTokens: number; outputTokens: number };
  /** Provider-reported latency in ms. */
  latencyMs: number;
  /** Confidence where the provider can report one. */
  confidence?: number;
  /** Sources the provider grounded in. */
  sourceLineage: SourceLineage[];
}

export interface ProviderHealth {
  ok: boolean;
  /** Consecutive failures. The circuit breaker opens at a configured threshold. */
  consecutiveFailures: number;
  /** Epoch ms when the provider last succeeded. */
  lastSuccessAt?: number;
  /** Reason if not ok. */
  detail?: string;
}

export interface ProviderCapabilities {
  modalities: Array<'text' | 'vision' | 'audio' | 'embedding'>;
  supportsContextCaching: boolean;
  maxContextTokens: number;
  /** Maximum data class this provider is permitted to receive. */
  maxDataClass: DataClass;
  /** Safety tiers this provider is cleared for. */
  clearedSafetyTiers: SafetyTier[];
}

/**
 * The provider adapter (Doc 2 §7, ADR-0001). A provider change is a registry
 * change — no learner-path code may import a provider SDK.
 */
export interface ProviderAdapter {
  /** Stable provider id used by the registry. */
  readonly id: string;
  /** Model id this adapter serves. */
  readonly modelId: string;
  /** Fallback tier this adapter belongs to (1, 2 or 3). */
  readonly tier: Exclude<FallbackTier, 0 | 4>;
  /** Which data classes this adapter may receive. */
  readonly maxDataClass: DataClass;
  capabilities(): ProviderCapabilities;
  complete(req: CompletionRequest, ctx: RequestContext): Promise<CompletionResult>;
  health(): Promise<ProviderHealth>;
  /** Release provider-held credentials. Required by the exit procedure. */
  dispose(): Promise<void>;
}

/** Context threaded through a routed request. */
export interface RequestContext {
  requestId: string;
  /** Hard deadline in epoch ms. */
  deadlineAt: number;
  /** Signal to abort the call. */
  signal?: AbortSignal;
  /** Budget ledger for the sponsor or platform pool. */
  budget: BudgetLedger;
  /** The accessibility guardian; the provider must not bypass it. */
  guardian: AccessibilityGuardian;
  /** Whether this is a learner-facing emission. */
  learnerFacing: boolean;
}

/** Budget with a hard cap and no overage (Doc 16 §3.6, §4.2). */
export interface BudgetLedger {
  readonly poolId: string;
  readonly hardCapUnits: number;
  readonly consumedUnits: number;
  readonly overageEnabled: false;
  readonly unit: 'token' | 'request' | 'credit';
  /** Remaining units. Never negative. */
  remaining(): number;
  /** Record consumption. Throws when the cap would be exceeded and overage is off. */
  consume(units: number, meta?: { providerId?: string; modelId?: string; requestId?: string }): void;
  /** Snapshot for the ledger / sponsor reporting. */
  snapshot(): BudgetSnapshot;
}

export interface BudgetSnapshot {
  poolId: string;
  hardCapUnits: number;
  consumedUnits: number;
  remainingUnits: number;
  overageEnabled: false;
  unit: string;
  /** Entries recorded, for the ledger. */
  entries: Array<{ at: string; units: number; providerId?: string; modelId?: string; requestId?: string }>;
}

/** Task policy — the routing decision is made from policy, never from sponsor preference. */
export interface TaskPolicy {
  taskClass: TaskClass;
  safetyTier: SafetyTier;
  dataClass: DataClass;
  locale?: string;
  /** Accessibility profile hash; influences modality selection, not provider preference. */
  accessibilityProfileHash?: string;
  /** Preferred modality when several are acceptable. */
  preferredModality?: 'text' | 'vision' | 'audio';
}

export type TaskClass =
  | 'explain'          // tutoring explanation
  | 'socratic'         // guided questioning
  | 'quiz'             // practice and assessment
  | 'code_review'      // code explanation / walkthrough
  | 'research'         // retrieval-grounded research
  | 'exam_prep'        // exam preparation
  | 'translate'        // localisation
  | 'plan';            // planning / next-step guidance

export interface RoutingDecision {
  providerId: string;
  modelId: string;
  tier: FallbackTier;
  /** Why this provider — the human-readable policy trace. */
  reason: string;
  /** The ordered fallback chain that was considered. */
  fallbackChain: Array<{ providerId: string; tier: FallbackTier }>;
  /** Budget pool that will pay for it. */
  budgetPoolId: string;
  /** Whether the request was served without any model provider. */
  servedOffline: boolean;
}

/** OneKey gateway contract. */
export interface OneKeyGateway {
  route(policy: TaskPolicy, req: CompletionRequest, ctx: RequestContext): Promise<RoutingDecision>;
  complete(policy: TaskPolicy, req: CompletionRequest, ctx: RequestContext): Promise<CompletionResult>;
  /** Provider registry: a provider change is a registry change. */
  register(adapter: ProviderAdapter): void;
  unregister(providerId: string): void;
  listProviders(): ProviderAdapter[];
  /** Emergency disablement — the kill switch (Doc 6 §5). */
  killSwitch(providerId: string, reason: string): void;
  /** Circuit breaker state per provider. */
  circuitState(providerId: string): 'closed' | 'open' | 'half_open';
  /** Reset a circuit. */
  resetCircuit(providerId: string): void;
}

/**
 * Tier 0 — deterministic learning that requires no model provider at all.
 * This is the floor that keeps a learner learning when everything else fails.
 */
export interface TierZeroProvider {
  /** Deterministic retrieval for a task class. */
  serve(policy: TaskPolicy, req: CompletionRequest): Promise<CompletionResult | null>;
  /** List the offline bundle ids available. */
  bundles(): string[];
}

// ===========================================================================
// 4. LEDGER + PRIVATE STORE (Doc 2 §15; Doc 16 §3.5)
// ===========================================================================

export type LedgerEntryType =
  | 'sponsor_pledge' | 'sponsor_deposit' | 'credit_received' | 'credit_consumed'
  | 'device_purchase' | 'device_assignment' | 'exam_slot_sponsored' | 'prize_funded'
  | 'prize_paid' | 'grant_awarded' | 'campaign_approved' | 'impact_milestone'
  | 'reinvestment_allocation' | 'reconciliation_proof';

/** A ledger entry. Contains NO personal data — ever (Doc 2 §2.5). */
export interface LedgerEntry {
  /** Monotonic sequence number, starting at 1. */
  seq: number;
  type: LedgerEntryType;
  /** ISO-8601 timestamp. */
  at: string;
  /** Payload — hashes, counters, proofs only. */
  payload: Record<string, string | number | boolean | null>;
  /** Hash of the previous entry; "genesis" for seq 1. */
  previousEntryHash: string;
  /** Hash of this entry. */
  entryHash: string;
}

export interface ChainVerification {
  ok: boolean;
  entriesChecked: number;
  /** The seq where the chain first broke, if any. */
  brokenAtSeq?: number;
  detail?: string;
}

/** A public proof. Safe to publish. Contains no personal data. */
export interface PublicProof {
  seq: number;
  type: LedgerEntryType;
  at: string;
  payload: Record<string, string | number | boolean | null>;
  entryHash: string;
  previousEntryHash: string;
}

/** The public, append-only, hash-chained ledger. */
export interface LedgerStore {
  append(type: LedgerEntryType, payload: Record<string, string | number | boolean | null>, at?: string): LedgerEntry;
  /** All entries, oldest first. */
  all(): LedgerEntry[];
  /** Verify the hash chain end to end. */
  verify(): ChainVerification;
  /** Public export — must contain no personal data by construction. */
  exportPublic(): PublicProof[];
  /** Merkle root over the current chain — optional anchoring payload. */
  merkleRoot(): string;
}

/**
 * The private operational store. Holds identity, consent, safeguarding and
 * accessibility records. It is NEVER exposed to a sponsor and NEVER written
 * to the public ledger.
 */
export interface PrivateStore {
  put(record: PrivateRecord): void;
  get(id: string): PrivateRecord | undefined;
  all(): PrivateRecord[];
  /** Records of a given kind. */
  byKind(kind: PrivateRecordKind): PrivateRecord[];
}

export type PrivateRecordKind =
  | 'identity' | 'consent' | 'safeguarding' | 'accessibility_profile'
  | 'assessment' | 'session_transcript';

export interface PrivateRecord {
  id: string;
  kind: PrivateRecordKind;
  /** ISO-8601. */
  at: string;
  /** Arbitrary payload. Never reaches the public ledger. */
  data: Record<string, unknown>;
}

/** Field names that may never appear in a ledger payload. */
export const FORBIDDEN_LEDGER_FIELDS: readonly string[] = [
  'learner_id', 'learner_name', 'name', 'email', 'phone', 'address',
  'school_id', 'guardian_name', 'guardian_email', 'disability', 'health',
  'location', 'lat', 'lon', 'biometric', 'message', 'transcript', 'prompt',
  'dob', 'date_of_birth', 'national_id',
];

/** The 60 % reinvestment engine (Doc 2 §15, Doc 1 v1.2 §6). */
export interface ReinvestmentEngine {
  /** Compute the allocation for a period from ledger entries. */
  compute(entries: LedgerEntry[], period: { from: string; to: string }): ReinvestmentResult;
}

export interface ReinvestmentResult {
  /** Total eligible base in the period. */
  eligibleBase: number;
  /** Amount that must be reinvested (60 % by default). */
  requiredReinvestment: number;
  /** Amount actually allocated, by category. */
  allocated: Record<string, number>;
  /** Entries that were excluded and why. */
  excluded: Array<{ seq: number; reason: string }>;
  /** True when allocated >= required. */
  compliant: boolean;
}

// ===========================================================================
// 5. IDENTITY, CONSENT, RISK (Doc 2 §4.2; Doc 7 Phase 1)
// ===========================================================================

export type Role =
  | 'learner' | 'guardian' | 'mentor' | 'sponsor' | 'volunteer'
  | 'admin' | 'safeguarding_lead' | 'accessibility_lead' | 'auditor';

export interface Principal {
  id: string;
  roles: Role[];
  /** Attribute values used by ABAC evaluation. */
  attributes: Record<string, string | number | boolean>;
  /** Age band, used by age assurance. */
  ageBand?: 'under_13' | '13_15' | '16_17' | 'adult';
}

export interface IdentityService {
  register(p: Omit<Principal, 'roles'> & { roles?: Role[] }): Principal;
  authenticate(subjectId: string, credential: unknown): Promise<Principal | null>;
  get(id: string): Principal | undefined;
  assignRole(id: string, role: Role): void;
}

/**
 * Consent service. Withdrawal is ATOMIC and must lock sharing surfaces while
 * leaving core learning intact (Doc 2 §4.2; Phase 1 exit criteria).
 */
export interface ConsentService {
  /** Record a consent grant. */
  grant(grant: ConsentGrant): ConsentRecord;
  /** Withdraw a grant. Atomic: all sharing surfaces for that scope lock at once. */
  withdraw(learnerId: string, scope: ConsentScope): ConsentRecord;
  /** Current state of a scope. */
  state(learnerId: string, scope: ConsentScope): ConsentRecord;
  /** Whether a sharing surface may proceed. Core learning is never blocked by this. */
  mayShare(learnerId: string, scope: ConsentScope): boolean;
  /** Whether CORE LEARNING may proceed. Always true for a registered learner. */
  mayLearn(learnerId: string): boolean;
}

export type ConsentScope =
  | 'progress_visible_to_guardian'
  | 'work_visible_to_employers'
  | 'analytics_aggregate'
  | 'sponsor_aggregate_reporting'
  | 'mentor_contact'
  | 'memory_personalisation';

export interface ConsentGrant {
  learnerId: string;
  scope: ConsentScope;
  granted: boolean;
  at: string;
  /** Guardian granted it, where required. */
  guardianId?: string;
  /** Learner assent, where required. */
  learnerAssent?: boolean;
}

export interface ConsentRecord {
  learnerId: string;
  scope: ConsentScope;
  granted: boolean;
  updatedAt: string;
  /** History, for audit. */
  history: Array<{ at: string; granted: boolean; actor: 'learner' | 'guardian' | 'system' }>;
}

/** Age assurance (Doc 2 §4.2). */
export interface AgeAssuranceService {
  /** Resolve an age band. Returns null when assurance is inconclusive. */
  assure(subjectId: string, evidence: unknown): Promise<Principal['ageBand'] | null>;
  /** Whether the subject needs a guardian for the given scope. */
  requiresGuardian(ageBand: Principal['ageBand']): boolean;
}

/** Session risk (Doc 2 §4.2). */
export interface SessionRiskService {
  assess(subjectId: string, signals: Record<string, unknown>): { score: number; band: 'low' | 'medium' | 'high'; factors: string[] };
}

// ===========================================================================
// 6. SETTINGS (portability law — GLOBAL.md §9; ADR-0016)
// ===========================================================================

export interface EduGenesisSettings {
  /** Schema version — a settings file with a newer version is migrated, not ignored. */
  schemaVersion: number;
  server: {
    host: string;
    port: number;
  };
  paths: {
    /** Data folder. RELATIVE to the project root by default, so the project stays portable. */
    dataDir: string;
  };
  providers: {
    /** Which provider is Tier 1. */
    primary: string;
    /** Which provider is Tier 2. */
    secondary: string;
    /** Optional local model for Tier 3. */
    local?: string;
    /** API keys. NEVER logged, NEVER committed. */
    apiKeys: Record<string, string>;
  };
  features: {
    accessibilityGuardian: boolean;
    offlineBundle: boolean;
    telemetry: boolean;
    /** Ledger public anchoring. */
    publicAnchoring: boolean;
  };
  limits: {
    /** Hard cap for the default budget pool. */
    budgetUnits: number;
    /** Media budget per emission, bytes. */
    mediaBudgetBytes: number;
    /** Confidence below which uncertainty_note is mandatory. */
    confidenceThreshold: number;
  };
}

/** The default settings written on first run. */
export const DEFAULT_SETTINGS: EduGenesisSettings = {
  schemaVersion: 1,
  server: { host: '127.0.0.1', port: 8787 },
  paths: { dataDir: './.edugenesis-data' },
  providers: { primary: 'local-echo', secondary: 'local-echo', local: 'local-echo', apiKeys: {} },
  features: { accessibilityGuardian: true, offlineBundle: true, telemetry: false, publicAnchoring: false },
  limits: { budgetUnits: 1_000_000, mediaBudgetBytes: 5_242_880, confidenceThreshold: 0.7 },
};

// ===========================================================================
// 7. ERROR TYPES
// ===========================================================================

export class ContractViolation extends Error {
  constructor(public readonly violations: ArcViolation[]) {
    super(`Accessibility contract violated: ${violations.map((v) => `${v.id}(${v.severity})`).join(', ')}`);
    this.name = 'ContractViolation';
  }
}

export class BudgetExceededError extends Error {
  constructor(public readonly poolId: string, public readonly attempted: number, public readonly remaining: number) {
    super(`Budget pool "${poolId}" exhausted: attempted ${attempted} units, ${remaining} remaining, overage disabled.`);
    this.name = 'BudgetExceededError';
  }
}

export class ProviderUnavailableError extends Error {
  constructor(public readonly providerId: string, public readonly detail?: string) {
    super(`Provider "${providerId}" unavailable${detail ? `: ${detail}` : ''}`);
    this.name = 'ProviderUnavailableError';
  }
}

export class AllTiersExhaustedError extends Error {
  constructor(public readonly attempts: Array<{ tier: FallbackTier; providerId?: string; reason: string }>) {
    super(`All fallback tiers exhausted: ${attempts.map((a) => `T${a.tier}(${a.reason})`).join(' -> ')}`);
    this.name = 'AllTiersExhaustedError';
  }
}

export class LedgerTamperError extends Error {
  constructor(public readonly brokenAtSeq: number, public readonly detail: string) {
    super(`Ledger chain broken at seq ${brokenAtSeq}: ${detail}`);
    this.name = 'LedgerTamperError';
  }
}
