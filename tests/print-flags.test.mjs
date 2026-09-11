import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const source = dirname(dirname(fileURLToPath(import.meta.url))), cli = join(source, 'bin/agent-collab-mcp.mjs');
const guard = new URL('./fixtures/print-guard.mjs', import.meta.url).href;
const requested = 'ac_fixture_requested', fallback = 'ac_fixture_environment';
const base = ['--host','https://fixture.invalid','--client','cursor'];
const cases = [
  { name:'print before positional token', args:[...base,'--print',requested], print:true },
  { name:'print before positional token without environment fallback', args:[...base,'--print',requested], print:true, omitFallback:true },
  { name:'print does not rewrite existing configuration or create a backup', args:[...base,'--print',requested], print:true, existing:true },
  { name:'print and token before value flags', args:['--print',requested,...base], print:true },
  { name:'token first and bare print last', args:[requested,...base,'--print'], print:true },
  { name:'explicit true before token', args:[...base,'--print','true',requested], print:true },
  { name:'explicit false requests a fixture configuration write', args:[...base,'--print','false',requested], print:false },
  { name:'last repeated boolean false wins', args:[...base,'--print','true','--print','false',requested], print:false },
  { name:'last repeated boolean true wins', args:[...base,'--print','false','--print','true',requested], print:true },
  { name:'print with no positional token retains environment fallback', args:[...base,'--print'], print:true, token:fallback },
  { name:'valued flags still consume boolean-looking strings', args:[...base,'--label','true',requested,'--print'], print:true },
  { name:'equals syntax remains unsupported', args:[...base,requested,'--print=true'], print:false },
  { name:'unrecognized flag handling remains unchanged', args:[...base,'--unrecognized',requested,'--print'], print:true, token:fallback },
];
// These are the exact other flags consumed as booleans by the current CLI.
// Using connect+print tests parser token preservation without starting their
// associated worker/startup/cleanup actions, which are not exercised here.
for (const flag of ['write','once','apply','configure','start','install','uninstall','reset-recovery','verify-github','retry-failed','report','resume']) cases.push({ name:`recognized --${flag} does not consume a following positional token`, args:[...base,'--print','true',`--${flag}`,requested], print:true });

for (const item of cases) test(item.name, { timeout: 15000 }, t => {
  const temporaryRoot = resolve(tmpdir()), prefix = join(temporaryRoot, 'agent-collab-print-');
  const home = mkdtempSync(prefix), file = join(home,'.cursor/mcp.json');
  const original = '{"unrelated":{"keep":true},"mcpServers":{"another":{"url":"https://other.invalid"}}}';
  if (item.existing) { mkdirSync(dirname(file)); writeFileSync(file, original); }
  t.after(() => { assert.equal(dirname(resolve(home)), temporaryRoot); assert.ok(home.startsWith(prefix)); rmSync(home,{recursive:true,force:true}); });
  const child = spawnSync(process.execPath, ['--import',guard,cli,'connect',...item.args], {
    cwd:home, env:{ ...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{}), ...(process.env.WINDIR?{WINDIR:process.env.WINDIR}:{}), HOME:home,USERPROFILE:home,CODEX_HOME:join(home,'.codex'),TEMP:home,TMP:home,FIXTURE_HOME:home,FIXTURE_SOURCE:source,...(!item.omitFallback?{AGENT_COLLAB_TOKEN:fallback}:{}) },
    encoding:'utf8',timeout:8000,maxBuffer:32768,windowsHide:true,
  });
  const saved = existsSync(file)?readFileSync(file,'utf8'):null;
  const files = readdirSync(home,{recursive:true}).map(String).sort();
  const savedToken = saved?JSON.parse(saved).mcpServers?.['agent-collab']?.headers?.Authorization:null;
  const proof = existsSync(join(home,'guard-observation.json'))?JSON.parse(readFileSync(join(home,'guard-observation.json'),'utf8')):null;
  assert.equal(child.error,undefined); assert.equal(child.status,0,child.stderr);
  assert.ok(proof,'Child must execute its no-network/no-client guard'); assert.deepEqual(proof.forbidden,[]);
  const token=item.token??requested;
  if(item.print){
    assert.equal(saved,item.existing?original:null,'Print-only mode must leave configuration unchanged');
    assert.ok(!files.some(p=>p.includes('.backup-')||p.includes('.tmp-')),'Print-only must not create write artifacts');
    assert.ok(child.stdout.includes(`Bearer ${token}`),'Print-only must use the intended positional/environment token');
    assert.ok(!child.stdout.includes(`Bearer ${token===requested?fallback:requested}`));
  }else{
    assert.equal(savedToken,`Bearer ${token}`); assert.ok(saved!==null);
  }
});
