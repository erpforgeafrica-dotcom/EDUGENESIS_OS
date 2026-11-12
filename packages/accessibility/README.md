# @edugenesis/accessibility

Owned by swarm unit **packages/accessibility**. Implements the interfaces declared in `packages/contracts`.

- Source: `src/`
- Tests: `src/**/*.test.ts` (compiled to `dist/**/*.test.js`, run with `node --test`)
- This package MUST NOT import a provider SDK. Provider access lives behind `packages/onekey`.
- This package MUST NOT contain a raw hex colour or a hardcoded absolute path.

## What it is

The enforcement point of the **Accessibility Runtime Contract** (Doc 2 §2.3: *"Accessibility is
not a post-processing layer. It is a runtime contract."*). Every learner-facing emission is checked
before it can reach a learner.

| Module | Authority | Purpose |
|---|---|---|
| `arc-invariants.ts` | 07 §5.3 | The 12 CI invariants as machine-checkable predicates. Each names the exact offending path. |
| `validator.ts` | Doc 2 §2.3 | Evaluates the invariant set → `{ ok, violations, passed }`. |
| `guardian.ts` | Doc 6 §7.3 | The interception point. Refuses to deliver a non-compliant emission and marks it `withheld`. |
| `equivalence.ts` | 07 §4 | The Multimodal Equivalence Rule: per-modality required dimensions and withhold conditions. |
| `bcp47.ts` | RFC 5646 | Syntactic BCP-47 validation (used by ARC-I5). |
| `content-hash.ts` | 07 §5.3 ARC-I9 | Canonical, key-order-independent content digest. |

## The 12 invariants

| ID | Severity | Rule |
|---|---|---|
| ARC-I1 | Blocker | `accessible_alternative` exists and `equivalence_verified` is `true` |
| ARC-I2 | Blocker | `risk_tier` ∈ {0,1,2,3,4} |
| ARC-I3 | Blocker | `source_lineage` non-empty when `risk_tier >= 2` |
| ARC-I4 | High | `uncertainty_note` present when `confidence_score` is below the routing threshold |
| ARC-I5 | Blocker | `language.primary` is a valid BCP-47 tag; `reading_level` present |
| ARC-I6 | High | `sensory_profile` names the variants actually produced |
| ARC-I7 | Blocker | `interaction_mode.input` includes `keyboard` for interactive surfaces |
| ARC-I8 | Blocker | `withheld: true` emissions are never delivered |
| ARC-I9 | High | `metadata.content_hash` matches the canonical content bytes |
| ARC-I10 | High | total `media_bytes_total` respects the active delivery-mode budget |
| ARC-I11 | Blocker | `validation.gate === 'approved'` where a learner accessibility profile is present |
| ARC-I12 | Blocker | `special_category_flag` set wherever an emission derives from an accessibility profile |

## Usage

```ts
import {
  createAccessibilityGuardian,
  createAccessibilityValidator,
} from '@edugenesis/accessibility';

const validator = createAccessibilityValidator();
const guardian = createAccessibilityGuardian(validator);

// In any service that produces learner-facing output, before delivery:
const outcome = await guardian.intercept(emission, { hasAccessibilityProfile: true });
if (!outcome.deliver) {
  // Never deliver. `outcome.emission.withheld` is true and `outcome.violations`
  // names every invariant that failed and the exact path that failed.
}
```

## Deliberate boundaries

- `ok` is true only when **no** invariant is violated: 07 §5.3 says a High-severity invariant
  "fails the build", and a learner-facing emission that fails the build is withheld.
- ARC-I1 is implemented exactly as worded (existence of the alternative plus the verified flag).
  The independent 07 §4.2 matrix check is exposed separately as `checkEquivalence(emission)` so
  that each ARC violation stays attributable to exactly one invariant.
- `locale` and `safetyTier` are carried on the resolved context but are not tested by any
  invariant: no rule in 07 §5.3 is conditioned on them.
- BCP-47 validation is syntactic (RFC 5646 §2.1 ABNF). Registry membership is not checked.
