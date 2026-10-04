const OWNER = 'Mmahdiabbasi1376';
const COMMAND_REPO = 'Poyacity.ir';
const COMMAND_ISSUE = 254;
const MAX_COMMAND_AGE_MS = 15 * 60 * 1000;
const CONSUMED_MARKER = '<!-- POYACITY_RELEASE_CONTROL_CONSUMED -->';

function json(res, status, payload) {
  res.status(status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function gh(token, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try { data = JSON.parse(raw); } catch { data = raw; }
  }
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { status: response.status, data };
}

function exactSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function validRepo(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+$/.test(value);
}

function validWorkflow(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\.(?:yml|yaml)$/.test(value);
}

function validRef(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._\/-]+$/.test(value);
}

async function assertOwnedRepo(token, repo) {
  if (!validRepo(repo)) throw new Error('invalid repository');
  const result = await gh(token, `/repos/${OWNER}/${repo}`);
  if (result.data?.owner?.login !== OWNER) throw new Error('repository owner mismatch');
  if (result.data?.archived) throw new Error('archived repository is not releasable');
  return result.data;
}

function normalizeInputs(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('inputs must be an object');
  }
  const inputs = {};
  for (const [key, input] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error('invalid input key');
    if (!['string', 'number', 'boolean'].includes(typeof input)) {
      throw new Error('invalid input value');
    }
    inputs[key] = String(input);
  }
  return inputs;
}

function applyCriticalWorkflowGuards(repo, workflow, ref, inputs) {
  if (repo === 'Poyacity.ir' && workflow === 'production-acceptance-orchestrator.yml') {
    if (ref !== 'main') throw new Error('production acceptance must use main');
    if (!exactSha(inputs.expected_commit)) throw new Error('production exact expected_commit required');
    if (inputs.production_confirmation !== 'AUTHORIZE_POYACITY_PRODUCTION') {
      throw new Error('production confirmation required');
    }
    if (!/^\d+$/.test(inputs.external_approval_run_id || '')) {
      throw new Error('production external approval run required');
    }
  }
  if (repo === 'Poyacity-Release-Control' && workflow === 'production-approval.yml') {
    if (ref !== 'main') throw new Error('production approval must use main');
    if (!exactSha(inputs.target_sha)) throw new Error('approval exact target_sha required');
  }
}

async function consumeComment(token, comment, result) {
  const body = `${String(comment.body || '').trim()}\n\n${CONSUMED_MARKER}\nResult: ${result}`;
  await gh(token, `/repos/${OWNER}/${COMMAND_REPO}/issues/comments/${comment.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body })
  });
}

function parseOwnerCommand(commentBody, nonce) {
  if (!/^[0-9a-f]{64}$/.test(nonce || '')) throw new Error('invalid nonce');
  const prefix = `/poyacity-control nonce=${nonce} `;
  const body = String(commentBody || '').trim();
  if (!body.startsWith(prefix)) throw new Error('command nonce mismatch');
  let command;
  try { command = JSON.parse(body.slice(prefix.length)); }
  catch { throw new Error('invalid command json'); }
  return command;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });

    const token = process.env.POYACITY_RELEASE_CONTROL_PAT;
    if (!token) return json(res, 503, { ok: false, error: 'release_control_pat_missing' });

    if (String(req.query?.health || '') === '1') {
      const probe = await gh(token, `/repos/${OWNER}/${COMMAND_REPO}`);
      return json(res, 200, {
        ok: true,
        owner: probe.data?.owner?.login === OWNER,
        control_repo: probe.data?.name === COMMAND_REPO
      });
    }

    const commentId = String(req.query?.comment_id || '');
    const nonce = String(req.query?.nonce || '');
    if (!/^\d+$/.test(commentId)) return json(res, 400, { ok: false, error: 'invalid_comment_id' });

    const commentResult = await gh(token, `/repos/${OWNER}/${COMMAND_REPO}/issues/comments/${commentId}`);
    const comment = commentResult.data;

    if (comment?.user?.login !== OWNER || comment?.author_association !== 'OWNER') {
      return json(res, 403, { ok: false, error: 'owner_identity_required' });
    }
    if (comment?.issue_url !== `https://api.github.com/repos/${OWNER}/${COMMAND_REPO}/issues/${COMMAND_ISSUE}`) {
      return json(res, 403, { ok: false, error: 'wrong_control_issue' });
    }
    if (String(comment?.body || '').includes(CONSUMED_MARKER)) {
      return json(res, 409, { ok: false, error: 'command_already_consumed' });
    }

    const created = Date.parse(comment?.created_at || '');
    if (!Number.isFinite(created) || Date.now() - created > MAX_COMMAND_AGE_MS) {
      return json(res, 403, { ok: false, error: 'command_expired' });
    }

    const command = parseOwnerCommand(comment.body, nonce);

    if (command.action === 'dispatch') {
      const repo = String(command.repo || '');
      const workflow = String(command.workflow || '');
      const ref = String(command.ref || 'main');
      if (!validWorkflow(workflow)) throw new Error('invalid workflow');
      if (!validRef(ref)) throw new Error('invalid ref');

      await assertOwnedRepo(token, repo);
      const inputs = normalizeInputs(command.inputs);
      applyCriticalWorkflowGuards(repo, workflow, ref, inputs);

      const dispatched = await gh(token, `/repos/${OWNER}/${repo}/actions/workflows/${workflow}/dispatches`, {
        method: 'POST',
        body: JSON.stringify({ ref, inputs })
      });
      if (dispatched.status !== 204) throw new Error(`unexpected dispatch status ${dispatched.status}`);

      await consumeComment(token, comment, `dispatch accepted repo=${repo} workflow=${workflow} ref=${ref}`);
      return json(res, 200, { ok: true, action: 'dispatch', repo, workflow, ref });
    }

    if (command.action === 'approve_environment') {
      const repo = String(command.repo || '');
      const runId = String(command.run_id || '');
      const environment = String(command.environment || '');
      if (!/^\d+$/.test(runId)) throw new Error('invalid run id');
      if (!/^[A-Za-z0-9_.-]+$/.test(environment)) throw new Error('invalid environment');

      await assertOwnedRepo(token, repo);
      const pending = await gh(token, `/repos/${OWNER}/${repo}/actions/runs/${runId}/pending_deployments`);
      const item = Array.isArray(pending.data)
        ? pending.data.find((entry) => entry.environment?.name === environment)
        : null;
      if (!item?.environment?.id) throw new Error('requested environment is not pending');

      await gh(token, `/repos/${OWNER}/${repo}/actions/runs/${runId}/pending_deployments`, {
        method: 'POST',
        body: JSON.stringify({
          environment_ids: [item.environment.id],
          state: 'approved',
          comment: 'Approved through Poyacity Owner Release Control'
        })
      });

      await consumeComment(token, comment, `environment approved repo=${repo} run_id=${runId} environment=${environment}`);
      return json(res, 200, { ok: true, action: 'approve_environment', repo, run_id: runId, environment });
    }

    return json(res, 400, { ok: false, error: 'unsupported_action' });
  } catch (error) {
    return json(res, Number(error?.status || 500), {
      ok: false,
      error: String(error?.message || error),
      github: error?.data || undefined
    });
  }
}
