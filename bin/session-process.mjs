/** An explicitly selected native client PID is positive lifecycle evidence.
 * Silence, access denied and PID reuse never establish that a session ended. */
export function createSessionProcessMonitor(pid, probe = value => process.kill(value, 0)) {
  if (pid === undefined) return null;
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) throw new Error('--session-pid must identify the running coding client, not this watcher.');
  const alive = () => {
    try { probe(pid); return true; }
    catch (error) { return error.code === 'ESRCH' ? false : null; }
  };
  if (alive() !== true) throw new Error('The selected coding client process cannot be verified.');
  let ended = false;
  return { ended() { if (!ended && alive() === false) ended = true; return ended; } };
}
