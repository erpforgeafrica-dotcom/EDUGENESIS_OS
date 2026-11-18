import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLifecycleTransition,
  canTransition,
  createModelCard,
  LIFECYCLE_STAGES,
  MODEL_CARD_ITEMS,
  type ModelCard,
} from './model-card.js';

// F1-09: the 13-item model card exists and is complete, and the lifecycle
// moves Select -> ... -> Retire one step at a time (never skipping approval).
test('model card: thirteen items, a complete card and an ordered lifecycle', () => {
  assert.equal(MODEL_CARD_ITEMS.length, 13, 'the card carries the thirteen mandatory items');
  assert.equal(new Set(MODEL_CARD_ITEMS).size, 13, 'the mandatory items are unique');
  assert.deepEqual([LIFECYCLE_STAGES[0], LIFECYCLE_STAGES[LIFECYCLE_STAGES.length - 1]], ['select', 'retire']);

  const values = Object.fromEntries(
    MODEL_CARD_ITEMS.map((item) => [item, `value-for-${item}`] as const),
  ) as ModelCard;
  const card = createModelCard(values);
  assert.deepEqual(Object.keys(card).sort(), [...MODEL_CARD_ITEMS].sort());

  const incomplete: Record<string, string> = { ...values };
  delete incomplete.owner;
  assert.throws(
    () => createModelCard(incomplete as ModelCard),
    /owner/,
    'a card missing a mandatory item is refused',
  );

  assert.equal(canTransition('select', 'evaluate'), true);
  assert.equal(canTransition('select', 'deploy'), false, 'a model may not skip evaluation and approval');
  assert.throws(() => assertLifecycleTransition('retire', 'deploy'), /one step at a time/i);
  assert.doesNotThrow(() => assertLifecycleTransition('approve', 'deploy'));
});
