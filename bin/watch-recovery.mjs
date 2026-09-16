import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** Own only a passive watch child. Never launches or resumes a model. */
export async function recoverWatch(entry, args, { signal, spawn = fork, wait = delay, onRestart = () => {} } = {}) {
  let retries = 0;
  while (!signal?.aborted) {
    const outcome = await new Promise((resolve, reject) => {
      let terminal = false;
      let killTimer;
      const child = spawn(entry, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
      const stop = () => {
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 10_000);
      };
      signal?.addEventListener('abort', stop, { once: true });
      child.on('message', message => { if (message?.type === 'watch_terminal') terminal = true; });
      child.once('error', error => { clearTimeout(killTimer); signal?.removeEventListener('abort', stop); reject(error); });
      child.once('close', (code, killedBy) => {
        signal?.removeEventListener('abort', stop);
        clearTimeout(killTimer);
        resolve({ code, killedBy, terminal });
      });
      if (signal?.aborted) stop();
    });
    if (signal?.aborted) return 143;
    if (outcome.terminal || outcome.code === 0 || [130, 143].includes(outcome.code) || ['SIGINT', 'SIGTERM'].includes(outcome.killedBy)) return outcome.code ?? 1;
    if (retries === 3) return 1;
    const milliseconds = [1000, 4000, 15000][retries++];
    onRestart({ attempt: retries, delay_ms: milliseconds });
    try { await wait(milliseconds, undefined, { signal }); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
  return 143;
}
