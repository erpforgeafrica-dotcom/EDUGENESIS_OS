/**
 * @edugenesis/verification — the verification harness.
 *
 * Public surface:
 *   - `GATE_REGISTRY`, `runAllGates`, `summarise` — the gate runner.
 *   - `findPiiViolations`, `findHexViolations`, `findAbsolutePathViolations`
 *     — the static scanners (pure, unit tested).
 *   - `defaultProjectRoot`, `collectSourceFiles` — tree discovery.
 *   - every individual gate, so a caller can run one gate in isolation.
 */
export type {
  Gate,
  GateContext,
  GateResult,
  GateSeverity,
  GateStatus,
  GateSummary,
  SourceFile,
  Violation,
  ViolationKind,
} from './types.js';

export { gateStatus } from './types.js';

export { GATE_REGISTRY, runAllGates, summarise } from './gates.js';

export {
  ALLOWLISTED_VALUE_MARKERS,
  findAbsolutePathViolations,
  findHexViolations,
  findPiiViolations,
  isAllowlistedValue,
  isNameLike,
  isPhoneShaped,
  stripComments,
} from './scan.js';

export {
  collectSourceFiles,
  defaultProjectRoot,
  findProjectRoot,
  listAssetsDir,
  listConfigFiles,
  listDocumentationFiles,
  listToolsDir,
  listWorkspaceSrcDirs,
  relativePosix,
  toPosix,
} from './paths.js';

export { contractGate, resolveValidator, asArcResult } from './gates/contract-gate.js';
export { failoverGate, collectTiers, findDrill, REQUIRED_TIERS } from './gates/failover-gate.js';
export { assessDrill, assessReport, assessScenario, extractTransitions, OPERATIONS_TERMS } from './gates/failover-gate.js';
export type { DrillAssessment, DrillExpectation, DrillTransition } from './gates/failover-gate.js';
export { ledgerGate, resolveLedger } from './gates/ledger-gate.js';
export { consentGate, resolveConsent } from './gates/consent-gate.js';
export { piiGate } from './gates/pii-gate.js';
export {
  noProviderLeakGate,
  PROVIDER_LEAK_EXCLUSIONS,
  PROVIDER_NEEDLES,
  isExcludedPath,
} from './gates/no-provider-leak-gate.js';
export { pathPortabilityGate } from './gates/path-portability-gate.js';
export { hexTokenGate } from './gates/hex-token-gate.js';
export {
  keyboardFocusGate,
  assessFocusVisibility,
  collectCssRules,
  hidesIndicator,
  TOKEN_STYLESHEET as FOCUS_TOKEN_STYLESHEET,
} from './gates/keyboard-focus-gate.js';
export type { FocusAssessment } from './gates/keyboard-focus-gate.js';
export {
  formSemanticsGate,
  assessFormSemantics,
  parseAttributes,
  SETTINGS_PAGE,
} from './gates/form-semantics-gate.js';
export type { FormSemanticsAssessment } from './gates/form-semantics-gate.js';
export {
  contractsBaselineGate,
  isFrozenPath,
  parseAmendments,
} from './gates/contracts-baseline-gate.js';
export type { AmendmentsRegister, ContractsAmendment } from './gates/contracts-baseline-gate.js';
export {
  exitCriteriaGate,
  parseExitCriteria,
  sourceSibling,
} from './gates/exit-criteria-gate.js';
export type {
  CriterionEvidence,
  EvidenceKind,
  ExitCriteriaRegister,
  ExitCriterionRow,
} from './gates/exit-criteria-gate.js';

export { brokenEmission, contentHash, validEmission } from './gates/emission-fixtures.js';
export {
  asFunction,
  describeExports,
  findExports,
  isRecord,
  loadWorkspacePackage,
  toExportRecord,
} from './gates/loading.js';
export type { LoadedPackage } from './gates/loading.js';
