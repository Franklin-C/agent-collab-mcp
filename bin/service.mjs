import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectClient } from './client-adapters.mjs';

const ps = value => `'${String(value).replaceAll("'", "''")}'`;
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unit = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$')}"`;
const winArg = value => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
const clean = value => { if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error('Invalid startup configuration value.'); return value; };

function run(file, args, input) {
  try { return execFileSync(file, args, { input, encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`Startup operation failed in ${file}. Check the current user's service manager and credential store; no system service or credential fallback was installed.`); }
}

/** Pure service definitions; no token value, shell evaluation, root account or
 * restart-on-success. An explicit Stop or authorization failure stays stopped. */
export function serviceDefinition(input) {
  const { platform, label, node, launcher, home, uid } = input;
  for (const value of [label, node, launcher, home]) clean(value);
  if (!/^ai\.ehgi\.worker\.[a-f0-9]{16}$/.test(label)) throw new Error('Invalid service identity.');
  if (platform === 'win32') {
    const taskScript = `$ErrorActionPreference='Stop'\n$workerUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name\n$action=New-ScheduledTaskAction -Execute ${ps(node)} -Argument ${ps(winArg(launcher))}\n$trigger=New-ScheduledTaskTrigger -AtLogOn -User $workerUser\n$principal=New-ScheduledTaskPrincipal -UserId $workerUser -LogonType Interactive -RunLevel Limited\n$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden -StartWhenAvailable\nRegister-ScheduledTask -TaskName ${ps(label)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null\n`;
    return { platform, path: null, content: taskScript, scope: 'Current logged-in Windows user; no elevation or stored account password.' };
  }
  if (platform === 'darwin') {
    if (!Number.isInteger(uid) || uid <= 0) throw new Error('A logged-in non-root user is required.');
    return { platform, path: posix.join(home, 'Library/LaunchAgents', `${label}.plist`), scope: 'Current macOS login session.', content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(launcher)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ProcessType</key><string>Background</string></dict></plist>\n` };
  }
  if (platform === 'linux') {
    if (!Number.isInteger(uid) || uid <= 0) throw new Error('A logged-in non-root user is required.');
    return { platform, path: posix.join(home, '.config/systemd/user', `${label}.service`), scope: 'Current Linux user manager; no system unit or lingering enabled.', content: `[Unit]\nDescription=EhGI enrolled workforce companion\n\n[Service]\nType=simple\nExecStart=${unit(node)} ${unit(launcher)}\nRestart=no\nTimeoutStopSec=45\nUMask=0077\n\n[Install]\nWantedBy=default.target\n` };
  }
  throw new Error(`Automatic startup is not supported on ${platform}. Start the enrolled worker manually.`);
}

function credentialScript(platform, label, state, mode) {
  if (platform === 'win32') {
    const path = ps(join(state, 'startup-credential.dpapi'));
    return `$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName System.Security\n${mode === 'store' ? `$bytes=[Text.Encoding]::UTF8.GetBytes($env:AGENT_COLLAB_TOKEN)\n$encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)\n[IO.File]::WriteAllBytes(${path},$encrypted)` : `$bytes=[Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes(${path}),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)\n[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))`}\n`;
  }
  return null;
}

function storeCredential(platform, label, state, token) {
  if (!/^ac_[a-zA-Z0-9_-]+$/.test(token ?? '')) throw new Error('Set a valid AGENT_COLLAB_TOKEN in the environment before installing startup.');
  if (platform === 'win32') { run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], credentialScript(platform, label, state, 'store')); return; }
  if (platform === 'darwin') {
    // security interactive mode accepts the credential through stdin, not argv.
    run('/usr/bin/security', ['-i'], `add-generic-password -U -a ${label} -s ${label} -w ${token}\n`); return;
  }
  if (platform === 'linux') { run('secret-tool', ['store', '--label', 'EhGI workforce agent token', 'application', 'ehgi-workforce', 'worker', label], token); return; }
  throw new Error('No supported current-user credential store is available.');
}

function readCredential(platform, label, state) {
  if (platform === 'win32') return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], credentialScript(platform, label, state, 'read'));
  if (platform === 'darwin') return run('/usr/bin/security', ['find-generic-password', '-a', label, '-s', label, '-w']);
  return run('secret-tool', ['lookup', 'application', 'ehgi-workforce', 'worker', label]);
}

export function startupLauncher({ platform, label, state, worker, options, path }) {
  const credential = platform === 'win32'
    ? `execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command','-'], { ...capture, input: ${JSON.stringify(credentialScript(platform, label, state, 'read'))} }).trim()`
    : platform === 'darwin' ? `execFileSync('/usr/bin/security', ['find-generic-password','-a',${JSON.stringify(label)},'-s',${JSON.stringify(label)},'-w'], capture).trim()`
    : `execFileSync('secret-tool', ['lookup','application','ehgi-workforce','worker',${JSON.stringify(label)}], capture).trim()`;
  return `import { execFileSync } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nimport { work } from ${JSON.stringify(worker)};\nimport { runWithStartupRecovery } from ${JSON.stringify(new URL('./startup-recovery.mjs', worker).href)};\n${path ? `process.env.PATH = ${JSON.stringify(path)};\n` : ''}const capture = { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['pipe','pipe','pipe'] };\nconst status = (state, reason) => writeFileSync(${JSON.stringify(join(state, 'startup-status.json'))}, JSON.stringify({ at: new Date().toISOString(), state, reason }), { mode: 0o600 });\nconst shutdown = new AbortController();\nconst stop = () => shutdown.abort();\nprocess.once('SIGINT', stop); process.once('SIGTERM', stop);\ntry {\n  process.env.AGENT_COLLAB_TOKEN = ${credential};\n  if (!/^ac_[a-zA-Z0-9_-]+$/.test(process.env.AGENT_COLLAB_TOKEN)) throw new Error('credential unavailable');\n  await runWithStartupRecovery(() => work({ ...${JSON.stringify(options)}, recoverStaleLock: true, signal: shutdown.signal }), { status, signal: shutdown.signal });\n} catch { status('needs_attention', 'Worker could not start or stopped with an error. Check enrollment, credentials, client permissions, and any existing worker lock.'); }\nfinally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }\n`;
}

/** Explicit install starts only at the next login. Never launches from within
 * a running worker. status and uninstall take only the saved --state directory. */
export function manageStartup(options) {
  if (!options.state) throw new Error('Startup requires the enrolled worker --state directory.');
  const state = realpathSync(options.state), platform = process.platform, home = homedir(), uid = process.getuid?.() ?? null;
  const label = `ai.ehgi.worker.${createHash('sha256').update(state).digest('hex').slice(0, 16)}`;
  const launcher = join(state, 'startup-worker.mjs'), metadata = join(state, 'startup.json');
  const definition = serviceDefinition({ platform, label, node: process.execPath, launcher, home, uid });
  const powershell = script => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], `$ErrorActionPreference='Stop'\n${script}`);
  const action = options.action ?? 'status';
  if (!['install', 'status', 'uninstall'].includes(action)) throw new Error('Startup action must be install, status, or uninstall.');
  if (action === 'status') {
    let registered = false, managerAvailable = true;
    try {
      if (platform === 'win32') registered = powershell(`$task=Get-ScheduledTask -TaskName ${ps(label)} -ErrorAction SilentlyContinue\nif ($task) { [Console]::Out.Write($task.State) }`).length > 0;
      else if (platform === 'darwin') { run('/bin/launchctl', ['print', `gui/${uid}`]); try { run('/bin/launchctl', ['print', `gui/${uid}/${label}`]); registered = true; } catch { /* Installed for the next login, but not loaded yet. */ } }
      else registered = ['enabled', 'enabled-runtime'].includes(run('systemctl', ['--user', 'is-enabled', `${label}.service`]));
    } catch { managerAvailable = false; }
    return { label, configured: existsSync(metadata), registered, managerAvailable, workerLockPresent: existsSync(join(state, 'worker.lock')), lastRun: existsSync(join(state, 'startup-status.json')) ? JSON.parse(readFileSync(join(state, 'startup-status.json'), 'utf8')) : null, scope: definition.scope };
  }
  if (action === 'uninstall') {
    if (!options.uninstall) throw new Error('Pass --uninstall to explicitly remove this user startup registration.');
    if (platform === 'win32') powershell(`$task=Get-ScheduledTask -TaskName ${ps(label)} -ErrorAction SilentlyContinue\nif ($task) { Stop-ScheduledTask -TaskName ${ps(label)}; Unregister-ScheduledTask -TaskName ${ps(label)} -Confirm:$false }`);
    else if (platform === 'darwin') {
      run('/bin/launchctl', ['print', `gui/${uid}`]);
      let loaded = false; try { run('/bin/launchctl', ['print', `gui/${uid}/${label}`]); loaded = true; } catch { /* A next-login installation may never have loaded. */ }
      if (loaded) run('/bin/launchctl', ['bootout', `gui/${uid}/${label}`]);
    }
    else run('systemctl', ['--user', 'disable', '--now', `${label}.service`]);
    for (const path of [definition.path, launcher, metadata].filter(Boolean)) if (existsSync(path)) unlinkSync(path);
    if (platform === 'linux') run('systemctl', ['--user', 'daemon-reload']);
    return { removed: true, label, credentialsRetained: true, note: 'User startup was removed. Recovery worktrees, checkpoints and the user credential remain available.' };
  }
  if (!options.install || !options.write || !options.repo || !options.client || !options.host) throw new Error('Installation requires --install --write --repo --client --host and successful enrollment.');
  if (!options.model && options.client !== 'claude-code') throw new Error('Startup requires --model for Codex and Gemini so usage can be priced.');
  if (existsSync(metadata)) throw new Error('Startup is already configured for this worker. Uninstall it before changing its configuration.');
  if (existsSync(join(state, 'worker.lock'))) throw new Error('Stop the current worker before installing startup; nested or duplicate runners are not permitted.');
  const prior = JSON.parse(readFileSync(join(state, 'state.json'), 'utf8'));
  if (!prior.enrollment?.verifiedAt || prior.enrollment.client !== options.client) throw new Error('Run real client enrollment with this --state and --client first.');
  const capability = inspectClient(options.client, options.executable);
  if (capability.version !== prior.enrollment.version) throw new Error('Client version changed since enrollment. Verify the new client before installing startup.');
  const entry = capability.prefixArgs?.[0] ?? capability.executable;
  const executable = isAbsolute(entry) ? realpathSync(entry) : (process.env.PATH ?? '').split(delimiter).map(directory => join(directory, entry)).find(path => existsSync(path));
  if (!executable) throw new Error('Cannot resolve a stable client executable for startup. Provide --executable and enroll that installation.');
  const host = new URL(options.host);
  if (host.protocol !== 'https:' || host.username || host.password || host.search || host.hash) throw new Error('Startup requires an HTTPS host without embedded credentials.');
  const repo = realpathSync(options.repo);
  const identity = createHash('sha256').update(`${options.host.replace(/\/+$/, '')}:${process.env.AGENT_COLLAB_TOKEN}:${repo}:${options.client}`).digest('hex');
  if (identity !== prior.identity) throw new Error('The host, repository, client or environment token differs from verified enrollment.');
  const workerOptions = { host: options.host.replace(/\/+$/, ''), repo, state, client: options.client, model: options.model, executable, write: true };
  for (const value of Object.values(workerOptions).filter(value => typeof value === 'string')) clean(value);
  storeCredential(platform, label, state, process.env.AGENT_COLLAB_TOKEN);
  if (readCredential(platform, label, state) !== process.env.AGENT_COLLAB_TOKEN) throw new Error('The current-user credential store did not pass its read-back check. Startup was not registered.');
  const worker = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'worker.mjs')).href;
  writeFileSync(launcher, startupLauncher({ platform, label, state, worker, options: workerOptions, path: process.env.PATH }), { mode: 0o600, flag: 'wx' });
  if (definition.path) { mkdirSync(dirname(definition.path), { recursive: true, mode: 0o700 }); writeFileSync(definition.path, definition.content, { mode: 0o600, flag: 'wx' }); }
  if (platform === 'win32') powershell(definition.content);
  else if (platform === 'darwin') { /* Loaded by the current user's next login. */ }
  else { run('systemctl', ['--user', 'daemon-reload']); run('systemctl', ['--user', 'enable', `${label}.service`]); }
  writeFileSync(metadata, JSON.stringify({ version: 1, label, platform, installedAt: new Date().toISOString(), installedBy: userInfo().username, scope: definition.scope, ...workerOptions }), { mode: 0o600, flag: 'wx' });
  return { installed: true, running: false, label, state, scope: definition.scope, next: 'Startup is registered for the next user login. No worker was launched by this command. Run worker with the same options now, or sign out and back in; then check startup status and verify a real assignment.' };
}
