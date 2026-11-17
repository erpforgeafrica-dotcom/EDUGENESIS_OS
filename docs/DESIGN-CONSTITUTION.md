# The EduGenesis Design Constitution

**Status:** ratified. This document is the standard the audit scores against.
It is written for this product. It is not borrowed from a brand, a framework,
or a design trend.

**Why it exists.** A learner who is poor, offline, fourteen and reading below
grade level deserves an interface that does not quietly insult them. Most
education products fail that learner in ways that are invisible in a screenshot:
a streak that shames, a countdown that panics, an upsell at the moment of
confusion, a "free plan" watermark on the one thing that matters. This
constitution names those failures in advance so that no future feature can
introduce them by accident.

Every principle below has an **enforcement** line. A principle with no
enforcement is a preference, and preferences lose to deadlines.

---

## C1 — Calm

**Definition.** The interface never manufactures urgency. Motion exists to
explain a state change, never to demand attention. The learner sets the pace.

**Forbids.**
- Countdowns, streaks, "don't lose your progress", red badges, unread counters.
- Autoplay of any media, including the ambient scene.
- Animations that continue after the state they describe has settled.

**Requires.**
- Motion tiers from the token stylesheet, all reducible to zero.
- A `prefers-reduced-motion` path that is genuinely still, not merely faster.

**Enforcement.** `--eg-duration-*` tokens only; the reduced-motion block in
`assets/edugenesis-tokens.css`; visual review at 0 ms and at default.

---

## C2 — Dignified

**Definition.** The learner is a person receiving an education, never a lead
being converted. The lesson is not an advertising surface.

**Forbids.**
- Sponsor logos, sponsor calls to action, or sponsor names inside a lesson.
- "Upgrade", "unlock", "go premium", or any word implying the current lesson is
  a lesser version.
- Copy that implies the learner owes the programme something.

**Requires.**
- Sponsor visibility only where the constitution places it: the public ledger
  and the sponsor's own aggregate report, never the learner's screen.
- Language that states what happened plainly, without gratitude-extraction.

**Enforcement.** Review of every shipped string in `apps/cli/public/*.html`;
the absence of any sponsor reference in the learner page is checkable by grep.

---

## C3 — Unhurried

**Definition.** Nothing the learner is doing is interrupted by the system. The
answer waits for them; the system does not wait for the answer.

**Forbids.**
- Auto-advance to another question.
- Session timeouts that discard a lesson the learner is reading.
- Modal interruptions during a request.

**Requires.**
- The result stays on screen until the learner replaces it.
- Requests that fail say so once, in place, and leave the question intact.

**Enforcement.** `apps/cli/public/learn.js` keeps the answer until the next
explicit submission; no timer exists in the learner script.

---

## C4 — Precise

**Definition.** Every claim the product makes is exactly what the system does,
at the moment it makes it. Precision is a moral position, not a style note: a
vague claim is a small lie the learner cannot check.

**Forbids.**
- "Here is a lesson" when no lesson exists.
- "Accessed for free" when the learner has no account.
- "Screen-reader tested" when no screen reader was run.
- Internal identifiers (`curriculum:kc_...`) appearing in learner copy.

**Requires.**
- A gap states that it is a gap, and what happens next.
- A verification claim names the artefact that carries it.

**Enforcement.** The `tier-zero` overreach guard; the learner-page tests that
assert the exact wording; the evidence rule in every audit (VERIFIED /
UNVERIFIED / OWNER-BLOCKED, with a command, URL or `file:line`).

---

## C5 — Generous

**Definition.** Space, size and contrast are given to the learner rather than
taken from them. Generosity is measured in the body, not in the layout grid.

**Forbids.**
- Touch targets below 44 px.
- Body text below the token's body size, or long-form text wider than the
  prose measure.
- Grey-on-grey that passes only because the text is large.

**Requires.**
- Every interactive element meets the token touch height.
- Contrast pairs meet WCAG AA in both themes, verified numerically.

**Enforcement.** `token-contrast` gate (every role pair, both themes);
`button.chip` carries `min-height: var(--eg-touch-target)`; measured in a real
browser at 360, 390 and 1280 CSS pixels.

---

## C6 — Equitable luxury

**Definition.** The learner with the cheapest phone gets the same interface as
the sponsor's guest. Luxury here means care, and care is not a paid tier.

**Forbids.**
- A feature gate on core learning.
- A degraded "lite" rendering path for slow connections that removes
  affordances rather than bytes.
- Different visual quality by cohort, region, or device class.

**Requires.**
- One stylesheet, one token set, one learner page for every learner.
- Performance work that reduces weight without reducing capability.

**Enforcement.** A single `learn.html`; the offline tier serves the same lesson
shape as a paid provider; review compares the 360 px render against the desktop
render for affordance parity.

---

## C7 — One surface, two truths

**Definition.** A lesson is one event with two honest views. The learner sees
what they learned. The operator sees what it cost, who paid, and what was
reinvested. Neither view is the other view with fields hidden — they are two
different, complete statements about the same event.

**Forbids.**
- A dashboard that shows the learner view with the numbers added.
- A public ledger that cannot be recomputed from the events it claims to
  record.
- An operator view that exposes a learner's identity to answer a money
  question.

**Requires.**
- The learner event carries enough (pseudonymous) detail to price it without
  naming the learner.
- The operator surface reads the same append-only record the public proof reads.
- Anything a sponsor sees is an aggregate that cannot be decomposed back to a
  person.

**Enforcement.** The ledger/private-store boundary (`packages/ledger`
`index.ts` states the two never touch); `pii-guard`; cohort suppression in
`sponsor-report.ts`.

---

## How a future feature is judged

A feature is admissible only if it can be described without violating C1-C7.
If it needs an exception, the exception is written here first, with the reason
and the owner's decision recorded, before the code is merged. Silent exceptions
are the failure mode this document exists to prevent.
