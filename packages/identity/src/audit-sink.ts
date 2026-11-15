/**
 * The durable audit sink (owner decision D-3).
 *
 * WHY A SINK AND NOT A DIRECT DEPENDENCY
 *   `@edugenesis/identity` must keep depending only on `@edugenesis/contracts`:
 *   the identity package knows about principals, consent and enrolment, and it
 *   must not know where the evidence is filed. The sink is therefore described
 *   STRUCTURALLY here — a tiny local interface — so the durable log (which
 *   lives in the ledger package) satisfies it by shape. A new dependency
 *   between two packages, for the sake of one method call, would be the wrong
 *   trade: it would drag the whole dependency graph along with it and change
 *   the frozen-contract posture for no gain.
 *
 * WHAT THE SINK CARRIES
 *   Opaque ids, a kind, and a flat detail bag. No name, no email address, no
 *   telephone number, and NEVER a credential secret. The identity package
 *   already guarantees that its own audit events carry opaque ids only; the
 *   sink inherits that promise and adds the durability of a hash-chained,
 *   append-only log.
 *
 * WHAT THE SINK IS NOT
 *   It is not the in-memory trail. `ConsentService.auditTrail` and
 *   `EnrolmentService.auditTrail` stay exactly as they were — a fast, in-process
 *   view of the same events. The sink is the durable copy that survives a
 *   restart and can be verified end to end.
 */

/** One event handed to the sink. */
export interface AuditSinkEvent {
  /** Who acted, when an actor is known. */
  readonly actorId?: string;
  /** Who the event is about. */
  readonly subjectId?: string;
  /** Flat, scalar-only detail. Never a secret. */
  readonly detail?: Record<string, string | number | boolean | null>;
}

/**
 * The durable audit sink.
 *
 * The durable implementation appends the event to a hash-chained, append-only
 * log and persists it. A caller that supplies no sink simply does not get a
 * durable copy — which is why this is optional everywhere it is accepted.
 */
export interface AuditSink {
  append(kind: string, event?: AuditSinkEvent): unknown;
}
