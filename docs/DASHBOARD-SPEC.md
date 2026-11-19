# EduGenesis OS — Dashboard Surfaces Specification

**Status:** built in scratch for orchestrator integration. No file in the source
repository was edited. All outputs live under the scratch root `w4/`.

**Scope:** three honest dashboard surfaces — learner, sponsor, operator — plus one
shared, dependency-free renderer and one token-only stylesheet. ADR-0014 (zero
runtime dependencies) is respected: plain HTML/CSS/JS, no build step, no framework.

---

## 1. Files created

| Scratch-relative path | Surface |
|---|---|
| `apps/cli/public/dashboard.html` | Learner dashboard |
| `apps/cli/public/sponsor.html` | Sponsor dashboard |
| `apps/cli/public/operator.html` | Operator console |
| `apps/cli/public/dashboard.js` | Shared renderer for all three surfaces |
| `apps/cli/public/dashboard.css` | Token-only styling for all three surfaces |
| `docs/DASHBOARD-SPEC.md` | This specification |

Each `data-surface` on `<body>` selects the renderer path: `learner`, `sponsor`,
`operator` (`dashboard.js`, body attribute read at top of the IIFE).

---

## 2. Exact routes each page calls

| Page | Method | Route | Purpose |
|---|---|---|---|
| `dashboard.html` | GET | `/api/dashboard/learner` | Progress + next lesson |
| `sponsor.html` | GET | `/api/dashboard/sponsor` | Funding, impact, ledger proof, report |
| `operator.html` | GET | `/api/dashboard/operator` | Health, tiers, budget, control state, audit |
| `operator.html` | POST | `/api/dashboard/operator/control` | Submit a kill or revive for two-person approval |

All GETs send `Accept: application/json` and `cache: 'no-store'`. The POST sends
`Content-Type: application/json` and `Accept: application/json`. After an
authoritative server response the operator page re-fetches
`/api/dashboard/operator` so the displayed state comes from the server, not from
the client's assumption.

No other network call is made. There are no third-party fonts, scripts, or
analytics in these pages: the token stylesheet is the only dependency.

---

## 3. Data models (the contract the orchestrator must implement)

Numbers are **only** rendered when the response supplies a real `number`
(`typeof v === 'number' && isFinite(v)`). A missing, null, or malformed field is
rendered as an honest empty/missing state — never as zero.

### 3.1 `GET /api/dashboard/learner`

```json
{
  "progress": {
    "lessonsCompleted": 12,
    "topicsExplored": 5
  },
  "nextLesson": {
    "title": "Fractions on a number line",
    "topic": "Mathematics",
    "description": "A short lesson building on what you already know."
  },
  "generatedAt": "2026-11-17T09:00:00.000Z"
}
```

- `progress` — `null` or an object; either counter may be omitted.
- `nextLesson` — `null` or an object with a non-empty `title`; `topic` and
  `description` are optional strings.
- `generatedAt` — accepted but deliberately **not rendered**. Showing a
  "freshness" clock on a learner's page would manufacture urgency (C1).

**Rendered:** "Lessons completed", "Topics explored" metric cards; next-lesson
card. **Never rendered:** streak, countdown, rank, comparison, shame copy.

### 3.2 `GET /api/dashboard/sponsor`

```json
{
  "funding": {
    "totalCommitted": 250000,
    "totalDisbursed": 180000,
    "currency": "USD"
  },
  "impact": {
    "lessonsDelivered": 9400,
    "learnersReached": null,
    "reportingPeriod": "2026-Q3"
  },
  "ledger": {
    "root": "<digest returned by the ledger>",
    "verificationState": "verified",
    "lastAnchoredAt": "2026-11-16T18:30:00.000Z"
  },
  "report": {
    "status": "draft",
    "url": null,
    "generatedAt": "2026-11-15T12:00:00.000Z"
  }
}
```

- `funding.currency` — ISO 4217; formatted with `Intl.NumberFormat`. An invalid
  code falls back to a plain number followed by the code, never a fabricated
  symbol.
- `impact.learnersReached` — a `number`, or `null` when cohort suppression
  applies. `null` shows: "The number of learners reached is withheld: the group
  is too small to report without risking the identification of a person." (C7).
- `ledger.verificationState` — one of `verified`, `anchored`, `pending`,
  `unverified`. Mapped to explicit text: "Verified", "Anchored and verified",
  "Pending verification", "Unverified". Anything else → "Not available".
- `ledger.root` — displayed verbatim in a monospace, wrapping element. The copy
  states it can be recomputed from the events it records.
- `report.status` — `final` or anything else. Anything other than the exact
  string `final` renders the badge `UNVERIFIED — DRAFT` plus the note "This
  report is a draft and has not been verified. Do not rely on its figures."
- `report.url` — only a same-origin path or an http(s) URL is accepted; anything
  else leaves the download link hidden.

**No learner identity field exists anywhere on this surface** (verified by
grep — see §7). Sponsor data is aggregate by construction.

### 3.3 `GET /api/dashboard/operator`

```json
{
  "health": {
    "status": "operational",
    "checkedAt": "2026-11-17T09:00:00.000Z"
  },
  "tiers": [
    { "tier": "Tier 0", "provider": "offline bundle", "status": "available" },
    { "tier": "Tier 1", "provider": "primary", "status": "available" }
  ],
  "budget": {
    "unitsUsed": 1420,
    "unitsCap": 5000,
    "tokensUsed": 880000,
    "burnRatePerHour": 3400
  },
  "controls": {
    "state": "running",
    "lastAction": null
  },
  "audit": [
    {
      "at": "2026-11-16T20:10:00.000Z",
      "action": "revive",
      "actor": "operator-2",
      "approver": "operator-4",
      "reason": "Provider restored"
    }
  ]
}
```

- `health.status` — `operational`, `degraded`, `down`; otherwise "Not available".
- `tiers` — array; an empty or missing array shows the honest empty state.
- `budget` — each counter rendered only when it is a real number; no computed
  percentage or "remaining" figure is invented by the client.
- `controls.state` — shown verbatim as "Current state as reported: …". The
  client never asserts a state it did not receive.
- `audit` — each entry shows time, action, actor, approver, reason. The audit
  list is the server's append-only record, not a client-side guess. **No
  learner identity is present** — actors and approvers are operators.

### 3.4 `POST /api/dashboard/operator/control`

Request:

```json
{
  "action": "kill",
  "actor": "<operator>",
  "reason": "<free text>",
  "approver": "<second person>"
}
```

Expected success (2xx): `{ "ok": true, "message": "<server outcome>", "state": "halted" }`.
Expected failure (non-2xx): `{ "error": "<why it was refused>" }`.

The client treats **HTTP `response.ok`** as the only success signal. On `ok: true`
it shows the server's `message`; otherwise it shows the server's `error`, or the
explicit line "The server did not confirm the action. Its outcome is unknown;
no success is claimed." A network failure shows "Offline. The action was not
confirmed by the server, so no success is claimed." There is no optimistic UI.

**Two-person rule (enforced before the button enables):** `actor` non-empty,
`reason` non-empty, `approver` non-empty, and the confirmation checkbox checked.
Only then do `Engage kill switch` and `Revive system` become enabled. The server
must still enforce the same rule — the client gate is a guard, not the authority.

---

## 4. Honest-state behaviour

| Condition | What the page shows |
|---|---|
| Request in flight | Live region: "Loading dashboard…"; grids marked `aria-busy="true"`. |
| HTTP error / malformed JSON | Live region: "Unavailable. The server returned no dashboard data, so no figures are shown." Per-section empty states explain what is missing. |
| Network failure | Live region: "Offline. The server did not respond, so no figures are shown." Section-specific offline text. No section falls back to zeros. |
| Field absent / null | Section empty state states what will appear when data exists. `next-card` stays hidden. |
| Cohort too small (sponsor) | Explicit suppression notice; the reach figure is not estimated. |
| Draft report | `UNVERIFIED — DRAFT` badge and an explicit do-not-rely note. |
| Control action | "Submitting … for server confirmation…" → only the server's answer is shown as the outcome. |

Every page owns a live region: `role="status" aria-live="polite"` on `#page-status`
(all three) and, on the operator page, `#control-status` as well.

---

## 5. Gate compliance — verified against the gate source

I read the four gate sources and replicated their checks locally against the
scratch outputs (`_verify.py`, 6/6 PASS). Findings:

| Gate | Source evidence (what the gate actually checks) | Result |
|---|---|---|
| `form-semantics` | `form-semantics-gate.ts:127-216` (unique ids, idref resolution, accessible names, hint wiring, live region); `:230-258` — **every** HTML under `apps/*/public` is discovered via `paths.ts:293-307` | PASS — 3/3 pages; all controls named; all idrefs resolve; all 4 hints referenced; live region present on each page |
| `keyboard-focus` | `keyboard-focus-gate.ts:36-37,143-219` — reads **only** `assets/edugenesis-tokens.css`: `:focus-visible` outline via token, offset, box-shadow second ring, fill override, forced-colors block, no plain `:focus` suppression | PASS — no change made to the token stylesheet; `dashboard.css` defines no `:focus` rule and no `outline:none` |
| `pwa-light-default` | `pwa-light-default-gate.ts:98-111,155-205` — `<html data-theme>`, `meta[name=color-scheme]`, manifest colours vs rendered canvas | PASS — every page declares `lang="en" data-theme="light"`, `meta color-scheme=light`, token stylesheet link and manifest link. No `theme-color` literal on new pages (they are not in the allowlist at `hex-token-gate.ts:29-33`) |
| `hex-token-governance` | `hex-token-gate.ts:35-93`; `scan.ts:27` (hex regex), `:33` (`rgba`/`hsla` regex), `:352-384` (findings) | PASS — zero hex and zero functional colour literals across all 5 scratch source files; every colour in `dashboard.css` is `var(--eg-…)` |

Additional structural checks: no inline `<style>`, no `style=` attributes, no
inline scripts, no duplicate ids, no dangling `aria-describedby`, `.skip-link`
to `#main` and `<main id="main">` on every page, scripts loaded only via
`<script src=… defer>`.

**Note:** the gates scan the repository, and these files are in scratch. The
checks above were replicated locally from the gate source, not executed by the
orchestrator's gate runner. The orchestrator must place these files into the
repo tree to have the live gates assess them.

---

## 6. Design constitution C1–C7

Verdicts are **static/measured evidence from the scratch sources**. Runtime
browser measurements are called out as UNVERIFIED in §8.

| Principle | Learner | Sponsor | Operator | Measured evidence |
|---|---|---|---|---|
| **C1 Calm** | PASS | PASS | PASS | Grep for `streak`, `countdown`, `unread`, `don't lose`, `setInterval`, `setTimeout`, `autoplay` across all HTML/CSS/JS → **0 matches**. No animations authored in `dashboard.css`; all motion comes from the token stylesheet's `--eg-duration-*` and its `prefers-reduced-motion` block (`edugenesis-tokens.css:168-174, 300-307`). `generatedAt` is accepted but never rendered. |
| **C2 Dignified** | PASS | PASS | N-A (no lesson surface) | No sponsor reference of any kind in `dashboard.html`; `dashboard.js` never renders a sponsor in the learner path. Sponsor copy is aggregate-only and states no individual is named. No upgrade/unlock/premium vocabulary (same 0-match grep as C1). |
| **C3 Unhurried** | PASS | N-A | N-A | No auto-advance, timer, or session expiry in `dashboard.js`. Empty/offline states leave the region intact and say what will appear (`dashboard.js:118-160, offlineLearner`). |
| **C4 Precise** | PASS | PASS | PASS | Every number is gated by `isNumber()` (`dashboard.js:39-41`) and formatted from the response; unknown enum values resolve to "Not available", never a confident label. Draft reports are explicitly `UNVERIFIED`. Control success requires `response.ok`. No internal identifiers are rendered as copy. |
| **C5 Generous** | PASS | PASS | PASS | Body/caption sizes and all spacing are `--eg-*` tokens; `--eg-touch-target` drives inputs and `.btn` (token stylesheet `:203,330-345`); `.db-check` label has `min-height: var(--eg-touch-target)`; token contrast ledger documents light-theme pairs (`edugenesis-tokens.css:63-76`). Tabular numerals on metric values. |
| **C6 Equitable luxury** | PASS | PASS | PASS | One shared `dashboard.css` and one token set for all three surfaces; no degraded path, no cohort-specific styling, no feature gate. No conditional rendering by device class. |
| **C7 One surface, two truths** | PASS (learner view only) | PASS (aggregate only) | PASS (cost/custody only) | Sponsor/operator HTML and JS contain **no** learner identity fields (grep for `learnerName`, `learner_name`, `learnerId`, `learner_id`, `guardian`, `email`, `@` → **0 matches**). Ledger root + verification state are shown on the sponsor page; `impact.learnersReached = null` triggers cohort suppression. Operator reads the same event-derived budget/audit record and never exposes a learner identity to answer a money question. |

---

## 7. Skill evidence

Both required skills were loaded and used this turn.

- **`ui-ux-pro-max`** — ran three searches with its own script:
  - `"analytics dashboard honest empty offline state" --domain ux` → "Empty States: show helpful message and action; don't render blank empty screens", "Compact Label Semantics: badges communicate state while chips/tags represent values or actions; don't encode status with colour alone". Applied: every section has a written empty state; badges carry text plus a reinforcing border.
  - `"destructive action confirmation approval" --domain ux` → "Confirmation Dialogs: confirm before irreversible actions", "Confirmation Messages: brief success message, no silent success". Applied: two-person gate, explicit server-driven status.
  - `"financial ledger monitoring admin dashboard" --design-system` → "Real-Time / Operations Landing: label telemetry as live only when backed by a current source, with update time and stale state; render a static final snapshot under reduced motion." Applied: no "live" claim; timestamps come from the API; no client animation.
  - **Rejected** that design-system result's suggested glassmorphism colour palette (it contained raw colour literals). It conflicts with the ratified Aurora tokens and the hex-token gate. Only its structural/UX guidance was adopted.
- **`web-design-guidelines`** — fetched fresh from `https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md` (2026-11-17) and applied: semantic HTML (`<button>`, `<a>`, `<dl>`, `<label>`), live regions for async updates, `:focus-visible` from the token stylesheet with no `outline-none`, hierarchical headings with skip link, `…` ellipsis and `Intl.NumberFormat` / `Intl.DateTimeFormat`, `font-variant-numeric: tabular-nums` for number columns, empty-state handling, destructive-action confirmation, and `prefers-reduced-motion` via the token stylesheet.

---

## 8. Limitations / UNVERIFIED

- The API routes do not exist yet; render paths were verified statically, not against live responses. **UNVERIFIED** until the orchestrator adds the routes and exercises them.
- Token contrast ratios are quoted as documented in `assets/edugenesis-tokens.css`, not re-measured here. A browser contrast run at 360/390/1280 px was not performed. **UNVERIFIED**.
- No browser was driven in this step, so focus visibility, reduced-motion behaviour and responsive layout were checked by source inspection only. **UNVERIFIED** at runtime.
- The two-person rule is enforced client-side here; the server must enforce it independently. Server-side enforcement is **OUT OF SCOPE** for these files.
