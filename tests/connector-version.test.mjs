import test from 'node:test';
import assert from 'node:assert/strict';
import { belowMinimum, createConnectorDiagnostics } from '../bin/connector-version.mjs';
test('numeric versions reject malformed or unsafe components', () => {
  assert.equal(belowMinimum('0.9.0', '0.10.0'), true);
  assert.equal(belowMinimum('1.0.0', '0.10.0'), false);
  assert.equal(belowMinimum('0.3.1', '0.3.1'), false);
  for (const value of ['01.3.1', '0.3.1-beta', '9007199254740992.0.0', undefined]) assert.equal(belowMinimum(value, '0.3.1'), null);
});
test('warn once without running commands; report a same-version disk change', () => {
  const warnings = []; let changed = false;
  const diagnostics = createConnectorDiagnostics({version:'0.3.1', changed:() => changed, log:message => warnings.push(message)});
  assert.equal(diagnostics.observe({minimum:'0.3.1'}).state, 'current');
  changed = true;
  assert.deepEqual(diagnostics.report(), {version:'0.3.1',restart_required:true});
  assert.equal(diagnostics.observe({minimum:'0.3.1'}).state, 'restart_required');
  diagnostics.observe({minimum:'0.4.0'});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /same options/);
});
test('missing policy is unknown; lower versions warn only once', () => {
  const warnings = [];
  const diagnostics = createConnectorDiagnostics({version:'0.2.0', changed:() => false, log:message => warnings.push(message)});
  assert.equal(diagnostics.observe().state,'unknown');
  for (let i=0;i<3;i++) assert.equal(diagnostics.observe({minimum:'0.3.1'}).state,'outdated');
  assert.equal(warnings.length,1);
});
