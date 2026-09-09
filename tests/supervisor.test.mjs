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

test('timeout cannot acknowledge a child that exits zero after terminal output',async t=>{const o=setup(t);const executable=join(o.cwd,'client');writeFileSync(executable,'#!/usr/bin/env node\nprocess.on("SIGTERM",()=>process.exit(0));console.log(JSON.stringify({type:"turn.completed"}));setInterval(()=>{},1000);\n',{mode:0o700});await assert.rejects(runClient({...capability,executable},'fixture',{cwd:o.cwd,timeoutMs:250,spawn:(_command,args,opts)=>spawn(process.execPath,[executable,...args],opts)}),/did not complete/);});
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
