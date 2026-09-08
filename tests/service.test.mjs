import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceDefinition, startupLauncher } from '../bin/service.mjs';

const input = { label: 'ai.ehgi.worker.0123456789abcdef', node: '/usr/bin/node', launcher: '/home/me/worker/startup.mjs', home: '/home/me', uid: 1000 };
test('Windows uses the interactive current user, no privilege elevation, no duplicate instances', () => {
  const result = serviceDefinition({ ...input, platform: 'win32', node: "C:\\Users\\O'Brien\\node.exe", launcher: 'C:\\Worker Space\\startup.mjs' });
  assert.match(result.content, /LogonType Interactive -RunLevel Limited/); assert.match(result.content, /MultipleInstances IgnoreNew/);
  assert.match(result.content, /RestartCount 3 -RestartInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(result.content, /O''Brien/); assert.doesNotMatch(result.content, /Start-ScheduledTask|RunLevel Highest|AGENT_COLLAB_TOKEN|ac_/);
});
test('Linux systemd definition escapes units and uses only the user directory', () => {
  const result = serviceDefinition({ ...input, platform: 'linux', launcher: '/home/me/%a$money"quote/startup.mjs' });
  assert.equal(result.path, '/home/me/.config/systemd/user/ai.ehgi.worker.0123456789abcdef.service');
  assert.match(result.content, /%%a\$\$money\\"quote/); assert.match(result.content, /Restart=on-failure/); assert.match(result.content, /StartLimitBurst=4/); assert.match(result.content, /KillMode=control-group/); assert.doesNotMatch(result.content, /User=root|Environment=.*TOKEN|sudo/);
});
test('macOS uses a per-user LaunchAgent with escaped argument elements', () => {
  const result = serviceDefinition({ ...input, platform: 'darwin', launcher: '/home/me/a&b<quote>.mjs' });
  assert.match(result.path, /Library\/LaunchAgents/); assert.match(result.content, /a&amp;b&lt;quote&gt;/); assert.match(result.content, /<key>SuccessfulExit<\/key><false\/>/); assert.match(result.content, /<key>ThrottleInterval<\/key><integer>15<\/integer>/);
});
test('rejects injected configuration lines, invalid identities, root and unknown platforms', () => {
  assert.throws(() => serviceDefinition({ ...input, platform: 'linux', launcher: '/tmp/x\nExecStart=evil' }));
  assert.throws(() => serviceDefinition({ ...input, platform: 'win32', label: "bad'; remove" }));
  assert.throws(() => serviceDefinition({ ...input, platform: 'linux', uid: 0 }));
  assert.throws(() => serviceDefinition({ ...input, platform: 'unsupported' }));
});
test('launchers load credentials through protected user stores without token argv or saved token values', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const source = startupLauncher({ ...input, platform, state: '/home/me/worker', worker: 'file:///app/worker.mjs', options: { client: 'codex', write: true } });
    assert.match(source, /process.env.AGENT_COLLAB_TOKEN =/); assert.doesNotMatch(source, /ac_secret|--token|token:/);
    assert.match(source, /needs_attention/); assert.match(source, /await runWithStartupRecovery\(\(\) => work/);
    assert.match(source, /recoverStaleLock: true, signal: shutdown.signal/);
    assert.match(source, /process.once\('SIGTERM', stop\)/); assert.match(source, /finally.*removeListener\('SIGINT'/);
    assert.match(source, /file:\/\/\/app\/startup-recovery.mjs/);
    assert.match(source, /beginStartupAttempt/); assert.match(source, /lifecycle.finish\('stopped'\)/);
    assert.match(source, /lifecycle\?\.finish\('needs_attention'\)/);
  }
});

test('startup preserves its enrolled profile and Codex home without copying credentials', () => {
  const source = startupLauncher({ ...input, platform: 'linux', state: '/home/me/worker', worker: 'file:///app/worker.mjs', options: { client: 'codex', profile: 'ehgi-worker' }, codexHome: '/home/me/private codex' });
  assert.match(source, /process.env.CODEX_HOME = "\/home\/me\/private codex"/);
  assert.match(source, /"profile":"ehgi-worker"/);
  assert.doesNotMatch(source, /API_KEY|auth\.json/);
});
