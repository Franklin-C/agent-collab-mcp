import test from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageReports } from '../bin/usage.mjs';
import { supervise } from '../bin/supervisor.mjs';
import { invocation, readClientEvent, runClient } from '../bin/client-adapters.mjs';
const capability = { client: 'codex', executable: process.execPath, version: 'fixture', resume: true };
function setup(t) { const dir=mkdtempSync(join(tmpdir(),'collab-supervisor-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));return {host:'http://localhost',token:'fixture-token',cwd:dir,state:dir,capability,log:()=>{},once:true}; }
const response = data => new Response(JSON.stringify(data),{status:200});
test('idle watch never starts a model',async t=>{let turns=0;const r=await supervise({...setup(t),fetch:async()=>response({next_seq:8,events:[]}),runClient:async()=>{turns++;}});assert.equal(turns,0);assert.equal(r.cursor,8);});

test('an already-stopped supervisor performs no watch and dispatches no client', async t => {
  const options = setup(t), controller = new AbortController(); controller.abort();
  let calls = 0, turns = 0;
  await supervise({ ...options, signal: controller.signal, fetch: async () => { calls++; return response({ next_seq: 1, events: [{ seq: 1 }] }); }, runClient: async () => { turns++; return { completed: true }; } });
  assert.equal(calls, 0); assert.equal(turns, 0);
});

for (const reason of ['stop', 'revoked', 'lost lease']) {
  test(`saved events wait for the hub before restart: ${reason}`, async t => {
    const options = setup(t);
    await supervise({ ...options, fetch: async () => response({ next_seq: 1, events: [{ seq: 1 }] }), runClient: async () => { throw new Error('interrupted'); } });
    let turns = 0;
    const restart = supervise({ ...options,
      fetch: async () => reason === 'stop' ? response({ stop_requested: true }) : new Response('{}', { status: reason === 'revoked' ? 401 : 409 }),
      runClient: async () => { turns++; return { sessionId: 'must-not-run' }; },
    });
    if (reason === 'stop') await restart;
    else await assert.rejects(restart, /Watch returned/);
    assert.equal(turns, 0);
    const state = JSON.parse(readFileSync(join(options.state, 'state.json')));
    assert.equal(state.pending.length, 1);
    assert.equal(state.cursor, 1);
  });
}

test('independent agent supervisors execute concurrently without sharing session state', { timeout: 5000 }, async t => {
  let started = 0;
  let release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  const results = await Promise.all(['agent-a', 'agent-b'].map(async token => {
    const options = { ...setup(t), token };
    await supervise({ ...options, fetch: async () => response({ next_seq: 1, events: [{ seq: 1 }] }), runClient: async () => {
      started++;
      if (started === 2) release();
      await bothStarted;
      return { sessionId: token };
    } });
    return JSON.parse(readFileSync(join(options.state, 'state.json')));
  }));
  assert.equal(started, 2);
  assert.deepEqual(results.map(state => state.sessionId), ['agent-a', 'agent-b']);
  assert(results.every(state => state.pending.length === 0));
});

test('MCP approval denial pauses immediately and retains events across restart', async t => {
  const options = setup(t);
  let turns = 0;
  const blocked = async () => { turns++; throw Object.assign(new Error('approval required'), { requiresApproval: true, sessionId: 'blocked-session' }); };
  await supervise({ ...options, fetch: async () => response({ next_seq: 1, events: [{ seq: 1 }] }), runClient: blocked });
  const state = JSON.parse(readFileSync(join(options.state, 'state.json')));
  assert.equal(state.pending.length, 1);
  assert.equal(state.failures, 3);
  assert.equal(state.pauseReason, 'mcp_approval_required');
  await supervise({ ...options, fetch: async () => response({ next_seq: 1, events: [] }), runClient: blocked });
  assert.equal(turns, 1);
  await supervise({ ...options, retryFailed: true, fetch: async () => response({ next_seq: 1, events: [] }), runClient: async () => ({ sessionId: 'resolved-session' }) });
  const resolved = JSON.parse(readFileSync(join(options.state, 'state.json')));
  assert.equal(resolved.pending.length, 0);
  assert.equal(resolved.pauseReason, undefined);
});

test('ordinary client failures pause and stop polling after the third attempt', { timeout: 5000 }, async t => {
  const options = setup(t), controller = new AbortController();
  let polls = 0, turns = 0;
  // Keep a test-only escape hatch so a regression cannot leave this test's
  // supervisor polling after the assertion timeout.
  const fallback = setTimeout(() => controller.abort(), 1000);
  try {
    await supervise({ ...options, once: false, signal: controller.signal,
      fetch: async () => {
        polls++;
        return response({ next_seq: polls, events: [{ seq: polls }] });
      },
      runClient: async () => {
        turns++;
        throw new Error('ordinary client failure');
      },
    });
  } finally {
    clearTimeout(fallback);
  }
  assert.equal(turns, 3);
  // One watch request may already be in flight when the third client failure
  // records the durable pause. It must not continue polling beyond that race.
  assert.ok(polls >= 3 && polls <= 4);
  const state = JSON.parse(readFileSync(join(options.state, 'state.json')));
  assert.equal(state.failures, 3);
  assert.equal(state.pending.length, polls);
  assert.equal(state.pauseReason, undefined);
});

for (const unavailable of [{ usageRecoveryError: 'Exact-session recovery unavailable.' }, { code: 'CODEX_USAGE_UNAVAILABLE' }]) {
  test(`missing provider accounting pauses across restart and --retry-failed: ${Object.keys(unavailable)[0]}`, async t => {
    const options = setup(t); let turns = 0;
    await supervise({ ...options, fetch: async () => response({ next_seq: 1, events: [{ seq: 1 }] }), runClient: async () => {
      turns++; throw Object.assign(new Error('Provider interruption'), { ...unavailable, sessionId: 'exact-session' });
    } });
    const saved = JSON.parse(readFileSync(join(options.state, 'state.json')));
    assert.equal(saved.pending.length, 1); assert.equal(saved.failures, 3);
    assert.equal(saved.pauseReason, 'provider_usage_unavailable'); assert.equal(saved.usageAttention.sessionId, 'exact-session');
    for (const retryFailed of [false, true]) await assert.rejects(supervise({ ...options, retryFailed,
      fetch: async () => { throw new Error('Paused supervisor must not poll for more paid work'); },
      runClient: async () => { turns++; },
    }), error => error.code === 'SUPERVISOR_USAGE_ATTENTION' && error.retryable === false);
    assert.equal(turns, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(options.state, 'state.json'))).usageAttention, saved.usageAttention);
  });
}

test('a completed Codex turn cannot acknowledge a structured MCP approval failure', async t => {
  const options = setup(t);
  const denied = { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'agent-collab', tool: 'get_briefing', status: 'failed', error: { message: 'MCP tool call requires approval, but approval policy is never' } } };
  const executable = join(options.cwd, 'client');
  writeFileSync(executable, `console.log(${JSON.stringify(JSON.stringify(denied))});\nconsole.log('{"type":"turn.completed"}');\n`);
  await assert.rejects(runClient({ ...capability, executable }, 'fixture', { cwd: options.cwd, timeoutMs: 2000, spawn: (_command, args, opts) => spawn(process.execPath, [executable, ...args], opts) }), error => error.requiresApproval === true);
  assert.equal(readClientEvent(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: denied.item.error.message } })).requiresApproval, false);
});
test('failed event survives restart and explicit resume uses the exact session',async t=>{const o={...setup(t),resume:true};await supervise({...o,fetch:async()=>response({next_seq:2,events:[{seq:2,text:'work'}]}),runClient:async(_c,_p,args)=>{args.onSession('session-123');throw new Error('offline')}});const s=JSON.parse(readFileSync(join(o.state,'state.json')));assert.equal(s.pending.length,1);assert.equal(s.cursor,2);let calls=0;await supervise({...o,fetch:async()=>response({next_seq:2,events:[]}),runClient:async(_c,p,args)=>{calls++;assert.equal(args.sessionId,'session-123');assert.match(p,/may be replayed/);return {sessionId:'session-123'}}});assert.equal(calls,1);assert.equal(JSON.parse(readFileSync(join(o.state,'state.json'))).pending.length,0);});
test('poll continues while worker runs and stop aborts child',async t=>{const o=setup(t);let polls=0,aborted=false;await supervise({...o,once:false,fetch:async()=>{polls++;return response(polls===1?{next_seq:1,events:[{seq:1}]}:{stop_requested:true})},runClient:async(_c,_p,args)=>new Promise((_,reject)=>args.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('stopped'))}))});assert.equal(polls,2);assert.equal(aborted,true);assert.equal(JSON.parse(readFileSync(join(o.state,'state.json'))).pending.length,1);});
test('state cannot be reused for another token',async t=>{const o=setup(t);await supervise({...o,fetch:async()=>response({next_seq:0,events:[]})});await assert.rejects(supervise({...o,token:'other'}),/another connection/);});
test('explicit session and permission flags; no latest or bypass',()=>{for(const client of ['codex','claude-code','gemini-cli']){const r=invocation({...capability,client},'session-1');assert(!r.args.includes('--last'));assert(!r.args.includes('--yolo'));assert(!r.args.includes('--dangerously-skip-permissions'));assert(r.args.includes('session-1'));}assert(!invocation({...capability,resume:false},'session-1').args.includes('resume'));});
test('terminal structured events distinguish provider failures',()=>{assert.equal(readClientEvent('{"type":"turn.completed"}').completed,true);assert.equal(readClientEvent('{"type":"result","is_error":true}').failed,true);assert.equal(readClientEvent('{"type":"thread.started","thread_id":"abc"}').sessionId,'abc');assert.equal(readClientEvent('noise').completed,false);});
test('permission mode changes cannot resume old state',async t=>{const o=setup(t);await supervise({...o,fetch:async()=>response({next_seq:0,events:[]})});await assert.rejects(supervise({...o,write:true}),/another connection/);});
test('Claude supervisor grants packet access and only the Agent Collab MCP tools', async t => {
  const o = setup(t);
  let runOptions;
  await supervise({ ...o, capability: { ...capability, client: 'claude-code' }, fetch: async () => response({ next_seq: 1, events: [{ seq: 1 }] }), runClient: async (_client, _prompt, options) => { runOptions = options; return { completed: true }; } });
  assert.deepEqual(runOptions.addDirs, [o.state]);
  assert.deepEqual(runOptions.allowedTools, ['mcp__agent-collab__*']);
});
test('Claude invocation serializes scoped packet and MCP permissions', () => {
  const result = invocation({ ...capability, client: 'claude-code' }, null, { write: true, addDirs: ['C:\\private\\supervisor'], allowedTools: ['mcp__agent-collab__*'] });
  assert.deepEqual(result.args.slice(-4), ['--add-dir', 'C:\\private\\supervisor', '--allowedTools', 'mcp__agent-collab__*']);
  assert(!result.args.includes('--dangerously-skip-permissions'));
});
test('usage upload failure retains metrics without replaying completed work',async t=>{const o=setup(t);let turns=0;const fetch=async url=>url.endsWith('/report')?new Response('',{status:503}):response({next_seq:1,events:[{seq:1}]});await supervise({...o,capability:{...capability,client:'claude-code'},fetch,runClient:async(_c,_p,args)=>{turns++;args.onUsage({type:'result',modelUsage:{'claude-test':{inputTokens:12,outputTokens:3,costUSD:0.1}}});return {sessionId:'one'}}});const state=JSON.parse(readFileSync(join(o.state,'state.json')));assert.equal(turns,1);assert.equal(state.pending.length,0);assert.equal(state.usage.length,1);assert.equal(state.usage[0].input_tokens,12);});

test('all Codex completed-turn usage survives upload failure with stable unique IDs', async t => {
  const options = setup(t);
  const fetch = async url => url.endsWith('/report') ? new Response('', { status: 503 }) : response({ next_seq: 1, events: [{ seq: 1 }] });
  await supervise({ ...options, model: 'gpt-test', fetch, runClient: async (_client, _prompt, args) => {
    args.onUsage({ type: 'turn.completed', event_id: 'first', usage: { input_tokens: 10, output_tokens: 2 } });
    args.onUsage({ type: 'turn.completed', event_id: 'first', usage: { input_tokens: 10, output_tokens: 2 } });
    args.onUsage({ type: 'turn.completed', event_id: 'second', usage: { input_tokens: 10, output_tokens: 2 } });
    return { sessionId: 'session' };
  } });
  const saved = JSON.parse(readFileSync(join(options.state, 'state.json'))).usage;
  assert.equal(saved.length, 2); assert.equal(new Set(saved.map(report => report.event_id)).size, 2);
  const sent = [];
  await supervise({ ...options, model: 'gpt-test', fetch: async (url, request) => { if (url.endsWith('/report')) { sent.push(JSON.parse(request.body)); return response({}); } return response({ next_seq: 1, events: [] }); } });
  assert.deepEqual(sent, saved);
});

test('explicit resume uses fresh billing invocation IDs for each cumulative run', async t => {
  const options = setup(t), delivered = []; let cursor = 0, turns = 0;
  const runClient = async (_client, _prompt, args) => {
    assert.equal(args.sessionId, turns ? 'same-native-session' : null); turns++;
    args.onSession('same-native-session');
    args.onUsage({ type: 'ehgi.codex_usage_snapshot', event_id: 'same-snapshot', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 5 } });
    return { sessionId: 'same-native-session' };
  };
  const fetch = async (url, request) => {
    if (url.endsWith('/api/usage/report')) { delivered.push(JSON.parse(request.body)); return response({}); }
    return response({ next_seq: ++cursor, events: [{ seq: cursor }] });
  };
  await supervise({ ...options, resume: true, model: 'gpt-test', fetch, runClient });
  await supervise({ ...options, resume: true, model: 'gpt-test', fetch, runClient });
  assert.equal(delivered.length, 2); assert(delivered.every(report => report.cumulative && report.session_id !== 'same-native-session'));
  assert.notEqual(delivered[0].session_id, delivered[1].session_id); assert.notEqual(delivered[0].event_id, delivered[1].event_id);
});

test('supervisor drains a final checkpoint after Stop with a fresh bounded delivery signal', async t => {
  const options = setup(t), delivered = []; let polls = 0;
  await supervise({ ...options, once: false, model: 'gpt-test', fetch: async (url, request) => {
    if (url.endsWith('/api/usage/report')) {
      assert.equal(request.signal.aborted, false); assert.equal(request.redirect, 'error');
      delivered.push(JSON.parse(request.body)); return response({});
    }
    return response(++polls === 1 ? { next_seq: 1, events: [{ seq: 1 }] } : { stop_requested: true });
  }, runClient: async (_client, _prompt, args) => {
    await new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true }));
    args.onUsage({ type: 'ehgi.codex_usage_snapshot', event_id: 'final-checkpoint', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 5 } });
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  } });
  assert.equal(delivered.length, 1); assert.equal(delivered[0].cumulative, true);
  assert.deepEqual(JSON.parse(readFileSync(join(options.state, 'state.json'))).usage, []);
});

test('supervisor checks Stop while a usage producer continues replenishing its outbox', { timeout: 3000 }, async t => {
  const options = setup(t); let polls = 0, generated = 0, delivered = 0, atStop, running = false, produce;
  await supervise({ ...options, once: false, model: 'gpt-test', fetch: async (url) => {
    if (url.endsWith('/api/usage/report')) {
      await new Promise(resolve => setTimeout(resolve, 5)); delivered++;
      if (running && generated < 20) produce();
      return response({});
    }
    if (++polls === 1) return response({ next_seq: 1, events: [{ seq: 1 }] });
    atStop = delivered; return response({ stop_requested: true });
  }, runClient: async (_client, _prompt, args) => {
    running = true;
    produce = () => { generated++; args.onUsage({ type: 'ehgi.codex_usage_snapshot', event_id: `snapshot-${generated}`, usage: { input_tokens: generated * 10, output_tokens: generated * 2, cached_input_tokens: generated * 5 } }); };
    produce(); await new Promise(resolve => args.signal.addEventListener('abort', resolve, { once: true }));
    running = false; throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  } });
  assert.equal(atStop, 1); assert.equal(generated, 2); assert.equal(delivered, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(options.state, 'state.json'))).usage, []);
});

test('Claude final per-query totals are counted once and include every reported model', async t => {
  const options = setup(t);
  await supervise({ ...options, capability: { ...capability, client: 'claude-code' }, fetch: async url => url.endsWith('/report') ? new Response('', { status: 503 }) : response({ next_seq: 1, events: [{ seq: 1 }] }), runClient: async (_client, _prompt, args) => {
    args.onUsage({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 2 } } });
    const result = { type: 'result', modelUsage: { first: { inputTokens: 10, outputTokens: 2 }, second: { inputTokens: 5, outputTokens: 1 } } };
    args.onUsage(result); args.onUsage(result);
    return { sessionId: 'same-resumable-session' };
  } });
  const saved = JSON.parse(readFileSync(join(options.state, 'state.json'))).usage;
  assert.equal(saved.length, 2); assert.equal(saved.reduce((sum, report) => sum + report.input_tokens, 0), 15);
  assert(saved.every(report => !report.cumulative));
});

test('timeout cannot acknowledge a child that exits zero after terminal output',async t=>{const o=setup(t);const executable=join(o.cwd,'client');writeFileSync(executable,'#!/usr/bin/env node\nprocess.on("SIGTERM",()=>process.exit(0));console.log(JSON.stringify({type:"turn.completed"}));setInterval(()=>{},1000);\n',{mode:0o700});await assert.rejects(runClient({...capability,executable},'fixture',{cwd:o.cwd,timeoutMs:250,spawn:(_command,args,opts)=>spawn(process.execPath,[executable,...args],opts)}),error=>error.code==='CLIENT_TIMEOUT'&&error.retryable===false&&Number.isFinite(Date.parse(error.timedOutAt)));});
test('successful structured child turn is acknowledged',async t=>{const o=setup(t);const executable=join(o.cwd,'client');writeFileSync(executable,'#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"thread.started",thread_id:"dedicated"}));console.log(JSON.stringify({type:"turn.completed"}));\n',{mode:0o700});const result=await runClient({...capability,executable},'fixture',{cwd:o.cwd,timeoutMs:2000,spawn:(_command,args,opts)=>spawn(process.execPath,[executable,...args],opts)});assert.equal(result.sessionId,'dedicated');assert.equal(result.completed,true);});

test('usage requires real input/output totals and model attribution',()=>{
  assert.deepEqual(usageReports('codex',{type:'turn.completed',usage:{}},'gpt-test'),[]);
  assert.deepEqual(usageReports('codex',{type:'turn.completed',usage:{input_tokens:3,output_tokens:1}},undefined),[]);
  assert.deepEqual(usageReports('claude-code',{type:'result',modelUsage:{model:{inputTokens:3}}}),[]);
  assert.deepEqual(usageReports('gemini-cli',{type:'result',stats:{input_tokens:-1,output_tokens:1}},'gemini-test'),[]);
  assert.equal(usageReports('codex',{type:'turn.completed',usage:{input_tokens:0,output_tokens:0}},'gpt-test')[0].input_tokens,0);
});

test('an already-cancelled client turn never spawns or reports a started run', async () => {
  for (const client of ['codex', 'claude-code', 'gemini-cli']) {
    const controller = new AbortController(); controller.abort();
    let spawns = 0; const activity = [];
    await assert.rejects(runClient({ client, executable: process.execPath }, 'cancelled fixture', {
      signal: controller.signal,
      spawn: () => { spawns++; throw new Error('Cancelled work reached process creation'); },
      onActivity: event => activity.push(event),
    }), error => error.name === 'AbortError' && error.retryable === false);
    assert.equal(spawns, 0); assert.deepEqual(activity, []);
  }
});

test('cancelling a real client reports cancellation rather than a provider error', async t => {
  const options = setup(t), executable = join(options.cwd, 'cancelled-client.cjs'), controller = new AbortController(), activity = [];
  writeFileSync(executable, 'console.log("client ready");setInterval(()=>{},1000);');
  await assert.rejects(runClient({ client: 'codex', executable: process.execPath, prefixArgs: [executable] }, 'fixture', {
    cwd: options.cwd, signal: controller.signal, timeoutMs: 3000,
    onOutput: () => controller.abort(), onActivity: event => activity.push(event.kind),
  }), error => error.name === 'AbortError' && error.retryable === false && /cancelled/.test(error.message) && !/provider error/.test(error.message));
  assert.ok(activity.includes('run_stopped')); assert.ok(!activity.includes('run_failed'));
});

for (const failure of ['transport', 'http']) test(`pending usage ${failure} is reported once, retained on exit and retried without new work`, async t => {
  const options = setup(t), messages = [], attempts = []; let turns = 0;
  await supervise({ ...options, model: 'gpt-test', log: message => messages.push(message), fetch: async (url, request) => {
    if (url.endsWith('/api/usage/report')) {
      attempts.push(JSON.parse(request.body));
      if (failure === 'transport') throw new Error('PRIVATE_TRANSPORT_DIAGNOSTIC');
      return new Response('', { status: 503 });
    }
    return response({ next_seq: 1, events: [{ seq: 1 }] });
  }, runClient: async (_client, _prompt, run) => {
    turns++; run.onUsage({ type: 'turn.completed', event_id: 'observed', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 5 } });
    return { sessionId: 'completed-fixture' };
  } });
  const first = JSON.parse(readFileSync(join(options.state, 'state.json')));
  assert.equal(turns, 1); assert.deepEqual(first.pending, []);
  assert.equal(first.usage.length, 1); assert.ok(attempts.length >= 2);
  assert.ok(attempts.every(report => JSON.stringify(report) === JSON.stringify(first.usage[0])));
  assert.equal(messages.filter(message => message.startsWith('Usage delivery is pending;')).length, 1);
  assert.equal(messages.filter(message => message.startsWith('Supervisor stopped with 1 usage report(s) retained')).length, 1);
  assert.doesNotMatch(messages.join('\n'), /PRIVATE_TRANSPORT_DIAGNOSTIC|fixture-token/);
  const retried = [], recoveredMessages = [];
  await supervise({ ...options, model: 'gpt-test', log: message => recoveredMessages.push(message), fetch: async (url, request) => {
    if (url.endsWith('/api/usage/report')) { retried.push(JSON.parse(request.body)); return response({}); }
    return response({ next_seq: 1, events: [] });
  }, runClient: async () => { turns++; throw new Error('Completed work must not be relaunched for delivery'); } });
  assert.equal(turns, 1); assert.deepEqual(retried, first.usage);
  assert.deepEqual(JSON.parse(readFileSync(join(options.state, 'state.json'))).usage, []);
  assert.equal(recoveredMessages.filter(message => /Usage delivery is pending|Supervisor stopped with/.test(message)).length, 0);
});

test('Stop reports usage added by the settling client when its bounded final drain fails', async t => {
  const options = setup(t), messages = [], attempted = []; let polls = 0;
  await supervise({ ...options, once: false, model: 'gpt-test', log: message => messages.push(message), fetch: async (url, request) => {
    if (url.endsWith('/api/usage/report')) {
      assert.equal(request.signal.aborted, false);
      attempted.push(JSON.parse(request.body)); return new Response('', { status: 503 });
    }
    return response(++polls === 1 ? { next_seq: 1, events: [{ seq: 1 }] } : { stop_requested: true });
  }, runClient: async (_client, _prompt, run) => {
    await new Promise(resolve => run.signal.addEventListener('abort', resolve, { once: true }));
    run.onUsage({ type: 'ehgi.codex_usage_snapshot', event_id: 'final', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 5 } });
    throw Object.assign(new Error('Fixture cancelled'), { name: 'AbortError' });
  } });
  const state = JSON.parse(readFileSync(join(options.state, 'state.json')));
  assert.equal(polls, 2); assert.equal(state.pending.length, 1);
  assert.equal(attempted.length, 1); assert.deepEqual(state.usage, attempted);
  assert.equal(messages.filter(message => message.startsWith('Usage delivery is pending;')).length, 1);
  const final = messages.filter(message => message.startsWith('Supervisor stopped with'));
  assert.equal(final.length, 1); assert.match(final[0], /1 usage report\(s\).*Restart with the same state/);
  assert.doesNotMatch(final[0], /next poll/);
});
