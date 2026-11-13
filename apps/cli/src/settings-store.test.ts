/**
 * Settings-store tests.
 *
 * Two promises are tested here:
 *
 *   1. THE COMMITTED DEFAULT IS NEVER WRITTEN. `settings/settings.json` ships
 *      with the project and is the baseline every other machine compares
 *      against. A CLI that mutated it would make every portable copy of the
 *      project disagree with the next.
 *
 *   2. THE CONTRACT AND THE COMMITTED FILE AGREE. `DEFAULT_SETTINGS` in the
 *      frozen contract package and `settings/settings.json` on disk are two
 *      copies of the same defaults. Two copies drift. This test is what makes
 *      the drift visible instead of silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SETTINGS } from '@edugenesis/contracts';

import { DEFAULT_SETTINGS_PATH, LOCAL_SETTINGS_PATH, isCommittedDefault, localOverridePath } from './paths.js';
import { loadSettings, writeSettingsFile } from './settings-store.js';

test('settings: the committed default is recognised as the committed default', () => {
  assert.equal(isCommittedDefault(DEFAULT_SETTINGS_PATH), true);
  assert.equal(
    isCommittedDefault(join(DEFAULT_SETTINGS_PATH, '..', 'settings.json')),
    true,
    'the comparison must be on the resolved path, not on the string',
  );
});

test('settings: the local override is not the committed default', () => {
  assert.equal(isCommittedDefault(LOCAL_SETTINGS_PATH), false);
  assert.equal(isCommittedDefault(localOverridePath()), false);
});

test('settings: an unrelated path is not the committed default', () => {
  assert.equal(isCommittedDefault(join(tmpdir(), 'not-the-project', 'settings.json')), false);
});

test('settings: writing the committed default is refused', () => {
  const loaded = loadSettings();

  assert.throws(
    () => writeSettingsFile(DEFAULT_SETTINGS_PATH, loaded.settings),
    /committed default/i,
    'the CLI must never mutate the file every other copy is compared against',
  );
});

test('settings: the local override is the only file the CLI writes', () => {
  assert.equal(localOverridePath(), LOCAL_SETTINGS_PATH);
  assert.ok(localOverridePath().endsWith('settings.local.json'));
});

test('settings: a legal write lands on disk and reads back', () => {
  const directory = mkdtempSync(join(tmpdir(), 'eg-settings-test-'));
  try {
    const target = join(directory, 'settings.local.json');
    const loaded = loadSettings();

    writeSettingsFile(target, loaded.settings);

    assert.ok(existsSync(target), 'the settings file must exist after a successful write');
    const written = JSON.parse(readFileSync(target, 'utf8')) as Record<string, unknown>;
    assert.equal(written['schemaVersion'], loaded.settings.schemaVersion);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('settings: the committed file matches the contract defaults exactly', () => {
  const committed = JSON.parse(readFileSync(DEFAULT_SETTINGS_PATH, 'utf8')) as Record<string, unknown>;

  assert.deepEqual(
    committed,
    DEFAULT_SETTINGS as unknown as Record<string, unknown>,
    'the frozen contract and the committed settings file must not drift apart',
  );
});
