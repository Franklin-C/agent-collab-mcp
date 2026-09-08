import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const folder of ['../bin/', './']) {
  const directory = new URL(folder, import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.mjs'))) {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(name, directory))], { stdio: 'inherit', windowsHide: true });
  }
}
