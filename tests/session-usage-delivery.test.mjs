import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNativeUsageDelivery as create } from '../bin/session-usage-delivery.mjs';
import { advanceSessionUsageWindow as advance } from '../bin/session-usage-window.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const options = { server: 'http://localhost', token: 'test-token', agentId: 'fixture-agent', source: 'client_json' };
function report(connectionScope) {
  const identity = { client: 'codex', sessionId: '01a07a24-a447-75b3-890e-ceb683c31bfe', connectionScope };
  const row = n => ({ model: 'gpt-6-astra', token_semantics: 'inclusive', input_tokens: n, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
  return advance(advance(null, [row(10)], identity).state, [row(20)], identity).reports[0];
}
const ack = body => Response.json({ ok: true, duplicate: false, id: hash([options.agentId, body.event_id]).slice(0, 40) });

test('retries a transient failure with identical report and no private fields or client-side pricing', async () => {
  const sent = [], waits = [];
  const delivery = create({ ...options, wait: async delay => waits.push(delay), fetch: async (url, request) => {
    assert.equal(url, 'http://localhost/api/usage/report');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer test-token');
    const body = JSON.parse(request.body); sent.push(body);
    return sent.length === 1 ? Response.json({ error: 'PRIVATE' }, { status: 503 }) : ack(body);
  } });
  assert.deepEqual(await delivery.deliver({ ...report(delivery.connectionScope), prompt: 'PRIVATE', cost_usd: 999 }), { ok: true });
  assert.deepEqual(sent[0], sent[1]); assert.deepEqual(waits, [1000]);
  assert(!JSON.stringify(sent).includes('PRIVATE')); assert(!JSON.stringify(sent).includes('cost_usd'));
});

test('authentication failures are not retried and remote error text is never forwarded', async () => {
  let calls = 0;
  const delivery = create({ ...options, fetch: async () => { calls++; return Response.json({ error: 'PRIVATE' }, { status: 401 }); } });
  await assert.rejects(delivery.deliver(report(delivery.connectionScope)), error => error.status === 401 && error.retryable === false && !String(error).includes('PRIVATE'));
  assert.equal(calls, 1);
});

test('a success for another report or agent cannot remove pending usage', async () => {
  const delivery = create({ ...options, fetch: async () => Response.json({ ok: true, duplicate: false, id: 'wrong-report' }) });
  await assert.rejects(delivery.deliver(report(delivery.connectionScope)), /did not match/);
});

test('source changes alter persisted identity and malformed reports never reach transport', async () => {
  const delivery = create({ ...options, fetch: async () => assert.fail('must not send') });
  assert.notEqual(delivery.connectionScope, create({ ...options, source: 'cli_stream' }).connectionScope);
  const valid = report(delivery.connectionScope);
  await assert.rejects(delivery.deliver({ ...valid, input_tokens: 999 }), /verified report/);
  await assert.rejects(delivery.deliver({ ...valid, model: 'x'.repeat(81) }), /verified report/);
  assert.throws(() => create({ ...options, server: 'http://external.example' }));
  assert.throws(() => create({ ...options, server: 'https://user:secret@example.com' }));
  assert.throws(() => create({ ...options, server: 'https://example.com/other' }));
});

test('operator cancellation stops before transmitting any report', async () => {
  const controller = new AbortController(); controller.abort();
  const delivery = create({ ...options, signal: controller.signal, fetch: async () => assert.fail('must not send') });
  await assert.rejects(delivery.deliver(report(delivery.connectionScope)), error => error.name === 'AbortError');
});
