/**
 * EduGenesis OS — `@edugenesis/ledger` public surface.
 *
 * Four responsibilities, deliberately kept in four modules with a hard boundary
 * between them:
 *
 *   hash.ts         deterministic hashing (SHA-256 + canonical JSON)
 *   pii-guard.ts    the two lines of defence that keep personal data out of a
 *                   published artefact
 *   ledger-store.ts the public, append-only, hash-chained ledger
 *   private-store.ts the private operational store and its de-identified view
 *   sqlite-private-store.ts the DURABLE (file backed) private store
 *   durable-audit-log.ts the DURABLE, hash-chained audit log for consent and
 *                   enrolment events
 *   sqlite-ledger-journal.ts the DURABLE journal behind the PUBLIC ledger
 *                   (ADR-0019): the file-first sink and the verified restore
 *                   for `createLedgerStore`'s optional seams
 *   reinvestment.ts the 60 % reinvestment engine (integer minor units)
 *   sponsor-report.ts the aggregate, privacy-reviewed artefact the Anchor
 *                   Sponsor receives
 *
 * The public ledger and the private store never touch: there is no code path
 * from `private-store.ts` to `ledger-store.ts`, and `private-store.ts` does not
 * import it (Doc 2 §2.5, §15; Doc 16 §3.5). The same separation holds for the
 * two durable modules: `sqlite-private-store.ts` and `durable-audit-log.ts`
 * import neither `ledger-store.ts` nor each other's private data.
 */

export {
  canonicalJson,
  sha256Bytes,
  sha256Canonical,
  sha256Hex,
  type JsonValue,
} from './hash.js';

export {
  assertNoPersonalData,
  EXTENDED_FORBIDDEN_LEDGER_FIELDS,
  findForbiddenFieldPaths,
  findPersonalDataValues,
  isForbiddenFieldName,
  normalizeFieldName,
  VALUE_DETECTION_RULES,
} from './pii-guard.js';

export {
  appendCorrection,
  assertChainIntact,
  computeEntryHash,
  createLedgerStore,
  GENESIS_HASH,
  LedgerPayloadError,
  LedgerPiiError,
  MERKLE_EMPTY_DOMAIN,
  type CorrectionInput,
  type LedgerPayload,
  type LedgerStoreFacade,
  type LedgerStoreOptions,
} from './ledger-store.js';

export {
  createPrivateStore,
  DEFAULT_MIN_COHORT_SIZE,
  PRIVATE_RECORD_KINDS,
  REDACTION_READ_KEYS,
  redactForSponsor,
  type SponsorRedaction,
  type SponsorRedactionCohort,
  type SponsorRedactionLearningArea,
  type SponsorRedactionOptions,
  type SponsorRedactionRegion,
} from './private-store.js';

export {
  createSqlitePrivateStore,
  type SqlitePrivateStoreOptions,
} from './sqlite-private-store.js';

export {
  createDurableAuditLog,
  type DurableAuditEvent,
  type DurableAuditLog,
  type DurableAuditLogOptions,
} from './durable-audit-log.js';

export {
  createSqliteLedgerJournal,
  LedgerPersistenceError,
  type JournalVerification,
  type SqliteLedgerJournal,
  type SqliteLedgerJournalOptions,
} from './sqlite-ledger-journal.js';

export {
  createReinvestmentEngine,
  ALLOCATION_ENTRY_TYPE,
  DEFAULT_REINVESTMENT_RATE_BPS,
  FUNDING_ENTRY_TYPES,
  type ReinvestmentEngineOptions,
  type ReinvestmentPeriod,
} from './reinvestment.js';

export {
  MONEY_FIELD,
  MONEY_FIELD_CANDIDATES,
  readAmountCents,
  roundDiv,
  sumCents,
  type AmountReadResult,
} from './money.js';

export {
  buildSponsorReport,
  SPONSOR_REPORT_SCHEMA_VERSION,
  type SponsorReport,
  type SponsorReportOptions,
} from './sponsor-report.js';
