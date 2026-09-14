import { posix, win32 } from 'node:path';

/** Claude's explicit metadata only. No shell parsing or shared-checkout guesses. */
export function createNativeWorkspaceMetadata(client, { sessionId, cwd, platform = process.platform }) {
  const path = platform === 'win32' ? win32 : posix;
  const normalize = value => platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
  const root = normalize(cwd);
  const pending = new Map();
  let branch = null, files = [];
  function relativeFile(value) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
    const absolute = path.resolve(cwd, value);
    const relative = path.relative(root, normalize(absolute));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const file = relative.split(path.sep).join('/');
    return file.length <= 512 && !file.includes(':') && !file.includes('\\') ? file : null;
  }
  return {
    observe(record) {
      if (client !== 'claude-code' || record?.sessionId !== sessionId || record.isSidechain === true
        || typeof record.cwd !== 'string' || !path.isAbsolute(record.cwd) || normalize(record.cwd) !== root) return;
      if (typeof record.gitBranch === 'string' && record.gitBranch.length > 0 && record.gitBranch.length <= 200
        && !/[\x00-\x20\x7f]/.test(record.gitBranch)) {
        if (branch !== record.gitBranch) { branch = record.gitBranch; files = []; pending.clear(); }
      }
      const parts = record.message?.content;
      if (!Array.isArray(parts)) return;
      for (const part of parts) {
        if (record.type === 'assistant' && part.type === 'tool_use' && ['Edit', 'Write', 'MultiEdit'].includes(part.name)
          && typeof part.id === 'string' && part.id.length > 0 && part.id.length <= 200) {
          const file = relativeFile(part.input?.file_path);
          if (file && pending.size < 100) pending.set(part.id, file);
        } else if (record.type === 'user' && part.type === 'tool_result') {
          const file = pending.get(part.tool_use_id);
          pending.delete(part.tool_use_id);
          if (file && (part.is_error === undefined || part.is_error === false)) {
            files = [...files.filter(value => value !== file), file].slice(-50);
            while (files.reduce((size, value) => size + Buffer.byteLength(value), 0) > 4096) files.shift();
          }
        }
      }
    },
    snapshot() { return branch === null && !files.length ? null : { branch, files: [...files] }; },
  };
}
