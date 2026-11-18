/**
 * Model card and lifecycle (Doc 09 §12.7).
 *
 * WHY a model card: the registry is not just a routing table — it is the
 * sponsor-facing record of WHAT each model is and WHY it is allowed near a
 * learner. The thirteen mandatory items make that record reviewable without
 * reading adapter code. The lifecycle records how a model moved from Select
 * to Retire, so a reviewer can see that it was approved before it served.
 *
 * The card and the lifecycle are RECORDED, never routing inputs — routing is
 * derived only from hard safety rules plus capability fit (policy.ts).
 */

/** The thirteen mandatory model-card items, in their canonical order. */
export const MODEL_CARD_ITEMS = [
  'modelId',
  'providerId',
  'version',
  'tier',
  'modalities',
  'maxContextTokens',
  'maxDataClass',
  'clearedSafetyTiers',
  'locales',
  'regions',
  'licence',
  'dataResidency',
  'owner',
] as const;

export type ModelCardItem = (typeof MODEL_CARD_ITEMS)[number];

/** A complete model card: every mandatory item, as a reviewable string. */
export type ModelCard = Readonly<Record<ModelCardItem, string>>;

/** The lifecycle, from Select through Retire (Doc 09 §12.7). */
export const LIFECYCLE_STAGES = [
  'select',
  'evaluate',
  'approve',
  'deploy',
  'operate',
  'retire',
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/** Build a model card, refusing a card that is missing a mandatory item. */
export function createModelCard(values: ModelCard): ModelCard {
  for (const item of MODEL_CARD_ITEMS) {
    if (typeof values[item] !== 'string' || values[item].trim() === '') {
      throw new Error(`model card is missing mandatory item '${item}'`);
    }
  }
  return { ...values };
}

/** Whether a lifecycle step advances exactly one rung toward Retire. */
export function canTransition(from: LifecycleStage, to: LifecycleStage): boolean {
  const fromIndex = LIFECYCLE_STAGES.indexOf(from);
  const toIndex = LIFECYCLE_STAGES.indexOf(to);
  return fromIndex >= 0 && toIndex >= 0 && toIndex === fromIndex + 1;
}

/** Refuse a lifecycle skip or a backwards move. */
export function assertLifecycleTransition(from: LifecycleStage, to: LifecycleStage): void {
  if (!canTransition(from, to)) {
    throw new Error(`lifecycle cannot move from '${from}' to '${to}': one step at a time toward retire`);
  }
}
