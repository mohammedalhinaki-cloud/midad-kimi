import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAuthIdentityChanged } from '../src/auth-routing.js';

test('same-account auth events do not trigger an app reroute', () => {
  assert.equal(hasAuthIdentityChanged('user-a', 'user-a'), false);
  assert.equal(hasAuthIdentityChanged(null, null), false);
  assert.equal(hasAuthIdentityChanged(undefined, null), false);
});

test('sign-in, sign-out, and account switches trigger an app reroute', () => {
  assert.equal(hasAuthIdentityChanged(null, 'user-a'), true);
  assert.equal(hasAuthIdentityChanged('user-a', null), true);
  assert.equal(hasAuthIdentityChanged('user-a', 'user-b'), true);
});
