# Runbook — Incident Response

**Principles.** Protect the learner first, preserve evidence second, disclose
only what is known. Every action is logged with a timestamp and an actor. Where
this runbook names no person, the contact is **VACANT** — that is a real gap to
be filled by the owner, not a name to be invented. No response time, uptime or
remedy is promised here.

## Escalation contacts

| Role | Contact | Status |
|---|---|---|
| Owner / Chief Systems Architect | **VACANT** | Owner to appoint |
| Operator on call (Nigeria) | **VACANT** | Owner to appoint |
| Safeguarding lead | **VACANT** | Owner to appoint |
| Legal / DPO (EU, Frankfurt hosting) | **VACANT** | Owner to appoint |
| Render platform support | Via the owner's Render account | Owner-only |

If every row is VACANT, the only escalation path is the owner. Record that
explicitly; do not guess an address.

## 1. Kill-switch drill

Purpose: prove that an operator can disable a provider and that the learner
runtime falls through instead of leaking a provider call.

1. Read the current state from the kill-switch store (`onekey-kill-switch` in
   `private.sqlite`, kind `safeguarding`; `apps/cli/src/kill-switch-store.ts`).
2. Engage the kill switch with an actor and a classification
   (`safety | residency | licence | operational`).
3. Send a learner request and confirm the provider is not dialled — the gateway
   falls through to Tier 0. Confirm the guardian still intercepts the emission.
4. Record the state and the observed tier in the incident log.
5. Disengage only on an owner decision, and record who authorised it.

A corrupt kill-switch state **fails loudly** by design. Never "repair" it by
assuming nothing is killed: that would silently re-enable a provider a human
disabled.

## 2. Provider failure

1. Confirm the failure from the gateway's own signal — a thrown provider call,
   a timeout, or a refused budget reservation — not from a guess.
2. The learner path reserves a per-request token budget and a deadline; an
   exhausted or failing provider falls through to the offline Tier 0 bundle.
   Verify the learner still received a guarded lesson.
3. Do not retry in a tight loop: repeated dialling is both a cost and an abuse
   signal. Note the failure and escalate to the operator.
4. If the provider is suspected to hold learner data, engage the kill switch
   (section 1) before further investigation, and open the data-flow review
   (`PRIVACY-DPIA-DATA-FLOW.md`).

## 3. Corrupted journal

Applies to `audit.sqlite` (append-only, hash-chained) and `ledger.sqlite`
(public sponsor journal).

1. Stop writes. A broken chain must not grow: the journal refuses to extend a
   chain whose stored bytes no longer match their canonical form.
2. Run the module `verify()` checks. They **report** the first broken sequence
   and **never throw**, so the evidence stays readable.
3. Do **not** delete or rewrite rows. A mistake is answered with a compensating
   event that names the sequence it corrects and why (ADR-0018/ADR-0019).
4. Take a byte copy of the affected file as evidence before any intervention.
5. Restore from a verified sealed snapshot per `RUNBOOK-BACKUP-RESTORE.md` into
   a **fresh** directory, then re-verify the chain.
6. Record the checksum of the snapshot used and the sequence where the chain
   broke. Escalate to the owner; no automatic "repair" is authorised.

## 4. Sleep / wake (free-tier spin-down)

1. A free instance spins down after ~15 minutes idle and its filesystem is
   ephemeral. On wake, check `/api/health` and confirm the stores reopened.
2. Run `verify()` on the audit log and the ledger journal. A clean boot proves
   only that the *instance's* files are intact.
3. Assume data from before a redeploy or spin-down is **gone** unless a sealed
   snapshot was taken off the instance. Do not tell a learner or sponsor their
   data was preserved on the strength of a green health check alone.
4. If data is missing, follow section 3 and the restore runbook. State the loss
   honestly; do not reconstruct evidence.

## 5. Rate-limit evasion / abuse

1. Recognise the pattern: many requests from one actor, repeated provider
   failures, or attempts to exceed the per-request token cap.
2. The gateway's budget ledger and token cap are the existing control surface;
   do not invent a new blocking rule in an incident.
3. Preserve the audit evidence (append-only). Escalate to the operator and
   safeguard lead; if a learner is involved, treat it as a safeguarding event.
4. Do not promise a ban, a permanent block or a refund. Those are owner
   decisions.

## 6. Learner data retention / deletion workflow

1. Identify the records: `private.sqlite` (identity, consent, safeguarding,
   assessment/transcript) and `audit.sqlite` (consent/enrolment events).
2. Confirm the request is authorised — a guardian may act only within the
   scopes they hold; a sponsor cannot request learner deletion. Map the actor to
   the consent service before acting.
3. Apply the retention schedule in `PRIVACY-DPIA-DATA-FLOW.md`. Deletion of a
   private record does **not** rewrite the audit chain: append a compensating
   event recording what was removed, by whom and on whose authority.
4. **Snapshots are part of the data.** A sealed backup taken before a deletion
   still contains the learner's data. Expire or re-take affected snapshots on
   the owner's decision; do not silently leave them in an owner-controlled
   location past the retention point.
5. Record the deletion, the scope, the actor and the snapshot handling in the
   incident log. No fixed deletion SLA is promised — the owner sets it.

## Evidence standard

For every incident, record: what was observed (with the command/output or file),
what was changed, what was deliberately **not** changed, who authorised it, and
what remains unknown. An unchecked claim is written as `UNVERIFIED`.
