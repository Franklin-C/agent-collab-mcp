/** Typed client diagnostics only; never return provider text or error metadata. */
export function codexRequiresUpdate(event) {
  if (!['error', 'turn.failed', 'task_complete'].includes(event?.type)) return false;
  const message = event.type === 'error' ? event.message : event.error?.message;
  if (typeof message !== 'string' || message.length > 4096) return false;
  let rejection;
  try { rejection = JSON.parse(message); } catch { return false; }
  return rejection?.type === 'error' && rejection.status === 400 && rejection.error?.type === 'invalid_request_error' &&
    typeof rejection.error.message === 'string' && /^The '[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}' model requires a newer version of Codex\. Please upgrade to the latest app or CLI and try again\.$/.test(rejection.error.message);
}
