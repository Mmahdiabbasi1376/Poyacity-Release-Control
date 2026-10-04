import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../api/control.mjs', import.meta.url), 'utf8');

test('control plane requires server-side PAT and OWNER-issued private command channel', () => {
  assert.match(source, /POYACITY_RELEASE_CONTROL_PAT/);
  assert.match(source, /COMMAND_REPO = 'Poyacity\.ir'/);
  assert.match(source, /COMMAND_ISSUE = 254/);
  assert.match(source, /author_association !== 'OWNER'/);
  assert.match(source, /comment\?\.user\?\.login !== OWNER/);
});

test('commands are short lived, nonce-bound, and consumed after success', () => {
  assert.match(source, /MAX_COMMAND_AGE_MS = 15 \* 60 \* 1000/);
  assert.match(source, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(source, /POYACITY_RELEASE_CONTROL_CONSUMED/);
  assert.match(source, /command_already_consumed/);
});

test('control plane exposes dispatch and environment approval without arbitrary GitHub proxying', () => {
  assert.match(source, /command\.action === 'dispatch'/);
  assert.match(source, /actions\/workflows\/\$\{workflow\}\/dispatches/);
  assert.match(source, /command\.action === 'approve_environment'/);
  assert.match(source, /pending_deployments/);
  assert.doesNotMatch(source, /command\.path/);
  assert.doesNotMatch(source, /command\.method/);
});

test('critical production workflows retain exact-SHA authorization guards', () => {
  assert.match(source, /production-acceptance-orchestrator\.yml/);
  assert.match(source, /AUTHORIZE_POYACITY_PRODUCTION/);
  assert.match(source, /external_approval_run_id/);
  assert.match(source, /production-approval\.yml/);
  assert.match(source, /approval exact target_sha required/);
});

test('workflow dispatch accepts GitHub HTTP 204 rather than inventing a run id response', () => {
  assert.match(source, /dispatched\.status !== 204/);
  assert.doesNotMatch(source, /workflow_run_id/);
});
