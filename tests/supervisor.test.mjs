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
test('failed event survives restart and resumes exact session',async t=>{const o=setup(t);await supervise({...o,fetch:async()=>response({next_seq:2,events:[{seq:2,text:'work'}]}),runClient:async(_c,_p,args)=>{args.onSession('session-123');throw new Error('offline')}});const s=JSON.parse(readFileSync(join(o.state,'state.json')));assert.equal(s.pending.length,1);assert.equal(s.cursor,2);let calls=0;await supervise({...o,fetch:async()=>response({next_seq:2,events:[]}),runClient:async(_c,p,args)=>{calls++;assert.equal(args.sessionId,'session-123');assert.match(p,/may be replayed/);return {sessionId:'session-123'}}});assert.equal(calls,1);assert.equal(JSON.parse(readFileSync(join(o.state,'state.json'))).pending.length,0);});
test('poll continues while worker runs and stop aborts child',async t=>{const o=setup(t);let polls=0,aborted=false;await supervise({...o,once:false,fetch:async()=>{polls++;return response(polls===1?{next_seq:1,events:[{seq:1}]}:{stop_requested:true})},runClient:async(_c,_p,args)=>new Promise((_,reject)=>args.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('stopped'))}))});assert.equal(polls,2);assert.equal(aborted,true);assert.equal(JSON.parse(readFileSync(join(o.state,'state.json'))).pending.length,1);});
test('state cannot be reused for another token',async t=>{const o=setup(t);await supervise({...o,fetch:async()=>response({next_seq:0,events:[]})});await assert.rejects(supervise({...o,token:'other'}),/another connection/);});
test('explicit session and permission flags; no latest or bypass',()=>{for(const client of ['codex','claude-code','gemini-cli']){const r=invocation({...capability,client},'session-1');assert(!r.args.includes('--last'));assert(!r.args.includes('--yolo'));assert(!r.args.includes('--dangerously-skip-permissions'));assert(r.args.includes('session-1'));}assert(!invocation({...capability,resume:false},'session-1').args.includes('resume'));});
test('terminal structured events distinguish provider failures',()=>{assert.equal(readClientEvent('{"type":"turn.completed"}').completed,true);assert.equal(readClientEvent('{"type":"result","is_error":true}').failed,true);assert.equal(readClientEvent('{"type":"thread.started","thread_id":"abc"}').sessionId,'abc');assert.equal(readClientEvent('noise').completed,false);});
test('permission mode changes cannot resume old state',async t=>{const o=setup(t);await supervise({...o,fetch:async()=>response({next_seq:0,events:[]})});await assert.rejects(supervise({...o,write:true}),/another connection/);});
test('usage upload failure retains metrics without replaying completed work',async t=>{const o=setup(t);let turns=0;const fetch=async url=>url.endsWith('/report')?new Response('',{status:503}):response({next_seq:1,events:[{seq:1}]});await supervise({...o,capability:{...capability,client:'claude-code'},fetch,runClient:async(_c,_p,args)=>{turns++;args.onUsage({type:'result',modelUsage:{'claude-test':{inputTokens:12,outputTokens:3,costUSD:0.1}}});return {sessionId:'one'}}});const state=JSON.parse(readFileSync(join(o.state,'state.json')));assert.equal(turns,1);assert.equal(state.pending.length,0);assert.equal(state.usage.length,1);assert.equal(state.usage[0].input_tokens,12);});

test('timeout cannot acknowledge a child that exits zero after terminal output',async t=>{const o=setup(t);const executable=join(o.cwd,'client');writeFileSync(executable,'#!/usr/bin/env node\nprocess.on("SIGTERM",()=>process.exit(0));console.log(JSON.stringify({type:"turn.completed"}));setInterval(()=>{},1000);\n',{mode:0o700});await assert.rejects(runClient({...capability,executable},'fixture',{cwd:o.cwd,timeoutMs:250,spawn:(_command,args,opts)=>spawn(process.execPath,[executable,...args],opts)}),/did not complete/);});
test('successful structured child turn is acknowledged',async t=>{const o=setup(t);const executable=join(o.cwd,'client');writeFileSync(executable,'#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"thread.started",thread_id:"dedicated"}));console.log(JSON.stringify({type:"turn.completed"}));\n',{mode:0o700});const result=await runClient({...capability,executable},'fixture',{cwd:o.cwd,timeoutMs:2000,spawn:(_command,args,opts)=>spawn(process.execPath,[executable,...args],opts)});assert.equal(result.sessionId,'dedicated');assert.equal(result.completed,true);});

test('usage requires real input/output totals and model attribution',()=>{
  assert.deepEqual(usageReports('codex',{type:'turn.completed',usage:{}},'gpt-test'),[]);
  assert.deepEqual(usageReports('codex',{type:'turn.completed',usage:{input_tokens:3,output_tokens:1}},undefined),[]);
  assert.deepEqual(usageReports('claude-code',{type:'result',modelUsage:{model:{inputTokens:3}}}),[]);
  assert.deepEqual(usageReports('gemini-cli',{type:'result',stats:{input_tokens:-1,output_tokens:1}},'gemini-test'),[]);
  assert.equal(usageReports('codex',{type:'turn.completed',usage:{input_tokens:0,output_tokens:0}},'gpt-test')[0].input_tokens,0);
});
