import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createSessionObservationParser } from './session-observation.mjs';

const failure = () => new Error('The exact session log cannot be safely observed.');
const canonical = path => process.platform === 'win32' ? path.toLowerCase() : path;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;

/** Stream the first snapshot, then only appended bytes. Content is never retained after parsing. */
export function createSessionFileObserver(path, options) {
  const maxRecordBytes = options.maxRecordBytes ?? 8 * 1024 * 1024;
  if (typeof path !== 'string' || !path || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1 || maxRecordBytes > 64 * 1024 * 1024) throw failure();
  const absolute = resolve(path), parser = createSessionObservationParser(options.client, options), decoder = new StringDecoder('utf8');
  let identity = null, offset = 0, pending = '', committed = false, reading = null, fault = null;
  async function read() {
    options.signal?.throwIfAborted();
    if (fault) throw fault;
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < offset
      || identity && !sameFile(identity, before) || canonical(await realpath(absolute)) !== canonical(absolute)) throw failure();
    const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      options.signal?.throwIfAborted();
      const opened = await file.stat();
      if (!opened.isFile() || opened.nlink !== 1 || !sameFile(opened, before) || opened.size < offset) throw failure();
      identity ??= opened;
      if (opened.size > offset) {
        const stream = file.createReadStream({ start: offset, end: opened.size - 1, autoClose: false, highWaterMark: 65536, signal: options.signal });
        for await (const chunk of stream) {
          options.signal?.throwIfAborted();
          pending += decoder.write(chunk);
          offset += chunk.length;
          let end;
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            if (Buffer.byteLength(line) > maxRecordBytes) throw failure();
            if (line.trim()) { parser.observe(JSON.parse(line)); committed = true; }
          }
          if (Buffer.byteLength(pending) > maxRecordBytes) throw failure();
        }
      }
      const after = await lstat(absolute);
      options.signal?.throwIfAborted();
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || !sameFile(after, opened) || after.size < offset) throw failure();
    } finally { await file.close(); }
    return committed ? parser.snapshot() : null;
  }
  return () => {
    if (reading) return reading;
    reading = read().catch(error => {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      fault = failure(); throw fault;
    }).finally(() => { reading = null; });
    return reading;
  };
}

export async function readSessionObservation(path, options) {
  return createSessionFileObserver(path, options)();
}
