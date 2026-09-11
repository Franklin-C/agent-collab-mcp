import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

export const networkAttempts = [];
const denied = name => (..._args) => { networkAttempts.push(name); throw new Error(`Fixture forbids network: ${name}`); };
for (const [owner, names] of [[http, ['request', 'get']], [https, ['request', 'get']], [net, ['connect', 'createConnection']], [tls, ['connect']], [net.Socket.prototype, ['connect']]]) {
  for (const name of names) owner[name] = denied(name);
}
globalThis.fetch = denied('fetch');
syncBuiltinESMExports();
