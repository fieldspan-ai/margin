// Shared, dependency-free .env loader used by the server, the seed script,
// and the MCP server. Reads KEY=value lines from <rootDir>/.env into
// process.env without clobbering values already present in the environment.
import fs from 'node:fs';
import path from 'node:path';

export function loadDotenv(rootDir) {
  const f = path.join(rootDir, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
