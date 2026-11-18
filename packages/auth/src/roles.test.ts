import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLE_PERMISSIONS,
  hasPermission,
  toContractRole,
  fromContractRole,
} from './roles.js';
import type { AuthRole, Permission } from './roles.js';

const ALL_ROLES: readonly AuthRole[] = ['learner', 'guardian', 'sponsor', 'operator', 'auditor'];
const ALL_PERMISSIONS: readonly Permission[] = [
  'settings:read',
  'enrol:write',
  'audit:read',
  'sponsor:read',
  'sponsor:write',
  'ledger:read',
  'report:read',
  'operator:kill',
  'operator:revive',
];

test('ROLE_PERMISSIONS matches the specified matrix for all five roles', () => {
  assert.deepEqual(ROLE_PERMISSIONS.learner, []);
  assert.deepEqual(ROLE_PERMISSIONS.guardian, ['enrol:write']);
  assert.deepEqual(ROLE_PERMISSIONS.sponsor, ['sponsor:read', 'report:read', 'ledger:read']);
  assert.deepEqual(ROLE_PERMISSIONS.operator, [
    'settings:read',
    'audit:read',
    'ledger:read',
    'report:read',
    'sponsor:read',
    'sponsor:write',
    'operator:kill',
    'operator:revive',
  ]);
  assert.deepEqual(ROLE_PERMISSIONS.auditor, ['audit:read', 'ledger:read', 'report:read']);
});

test('hasPermission allows exactly each role\'s permissions and denies the rest', () => {
  for (const role of ALL_ROLES) {
    for (const permission of ALL_PERMISSIONS) {
      const expected = ROLE_PERMISSIONS[role].includes(permission);
      assert.equal(hasPermission([role], permission), expected, `${role} / ${permission}`);
    }
  }
});

test('hasPermission unions multiple roles and denies an empty role set', () => {
  assert.equal(hasPermission([], 'enrol:write'), false);
  assert.equal(hasPermission(['learner', 'sponsor'], 'sponsor:read'), true);
  assert.equal(hasPermission(['learner', 'guardian'], 'audit:read'), false);
  assert.equal(hasPermission(['operator', 'auditor'], 'operator:kill'), true);
});

test('toContractRole maps operator to admin and leaves the others unchanged', () => {
  assert.equal(toContractRole('operator'), 'admin');
  assert.equal(toContractRole('learner'), 'learner');
  assert.equal(toContractRole('guardian'), 'guardian');
  assert.equal(toContractRole('sponsor'), 'sponsor');
  assert.equal(toContractRole('auditor'), 'auditor');
});

test('fromContractRole maps admin to operator and passes known roles through', () => {
  assert.equal(fromContractRole('admin'), 'operator');
  assert.equal(fromContractRole('learner'), 'learner');
  assert.equal(fromContractRole('guardian'), 'guardian');
  assert.equal(fromContractRole('sponsor'), 'sponsor');
  assert.equal(fromContractRole('auditor'), 'auditor');
});

test('fromContractRole fails closed to learner for unknown values', () => {
  assert.equal(fromContractRole('root'), 'learner');
  assert.equal(fromContractRole(''), 'learner');
  assert.equal(fromContractRole('ADMIN'), 'learner');
});
