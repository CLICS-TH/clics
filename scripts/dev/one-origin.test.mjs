// The dev proxy routes as vm1's nginx does: /api stripped to the backend, /audit kept for the dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { route } from './one-origin.mjs';

test('one-origin routes /api, /audit and everything else as the vm1 nginx site does', () => {
  assert.deepEqual(route('/api/auth/me'), { upstream: 'http://127.0.0.1:3001', path: '/auth/me' });
  assert.deepEqual(route('/api/ples/x/message?stream=1'), { upstream: 'http://127.0.0.1:3001', path: '/ples/x/message?stream=1' });
  assert.deepEqual(route('/api'), { upstream: 'http://127.0.0.1:3001', path: '/' });
  assert.deepEqual(route('/audit/login'), { upstream: 'http://127.0.0.1:3002', path: '/audit/login' });
  assert.deepEqual(route('/audit'), { upstream: 'http://127.0.0.1:3002', path: '/audit' });
  assert.deepEqual(route('/auditor'), { upstream: 'http://127.0.0.1:3000', path: '/auditor' }, 'a prefix match is per segment');
  assert.deepEqual(route('/apiary'), { upstream: 'http://127.0.0.1:3000', path: '/apiary' });
  assert.deepEqual(route('/login?next=1'), { upstream: 'http://127.0.0.1:3000', path: '/login?next=1' });
});
