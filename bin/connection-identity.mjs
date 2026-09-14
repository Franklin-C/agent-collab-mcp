import { createHash } from 'node:crypto';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export function activityConnectionScope(origin, token, identity) {
  if (identity === undefined) return createHash('sha256').update(`${origin}:${token}`).digest('hex');
  if (!identity || !validId(identity.projectId) || !validId(identity.agentId)) throw new Error('Activity requires a verified project and agent identity.');
  return createHash('sha256').update(JSON.stringify([origin, identity.projectId, identity.agentId])).digest('hex');
}

/** Resolve identity from the authenticated server, never user-supplied flags. */
export async function readConnectionIdentity({ server, token, signal, fetch: request = fetch }) {
  const url = new URL(server);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    || typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('Connection identity requires a safe server and credential.');
  signal?.throwIfAborted();
  const response = await request(`${url.origin}/api/agent/identity`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Object.assign(new Error(`Connection identity was not accepted (${response.status}). Update the server or reconnect before reporting.`), { status: response.status });
  const body = await response.json().catch(() => { throw new Error('Connection identity response was not valid JSON.'); });
  signal?.throwIfAborted();
  const identity = { projectId: body?.project_id, agentId: body?.agent_id };
  activityConnectionScope(url.origin, token, identity);
  return identity;
}
