// Seed a demo document so you can see Margin working immediately.
// Writes directly through the storage layer (no running server needed):
//
//   npm run seed     # creates the "demo" doc
//   npm start        # then open the printed reviewer link on your phone
//
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotenv } from './config.js';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
loadDotenv(ROOT);

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || './data');
await store.init(DATA_DIR);

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body{font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;max-width:720px;margin:0 auto}
  h1{font-size:28px;margin:0 0 4px} h2{margin-top:28px}
  .muted{color:#666} table{border-collapse:collapse;width:100%;margin:12px 0}
  th,td{border:1px solid #ddd;padding:8px 10px;text-align:left} blockquote{border-left:3px solid #8b7bff;margin:16px 0;padding:4px 16px;color:#444}
</style></head><body>
  <h1>Quarterly Update — Q2</h1>
  <p class="muted">Prepared by the agent · draft for review</p>

  <h2>Highlights</h2>
  <p>Revenue grew <strong>18% quarter over quarter</strong>, driven mostly by expansion in existing accounts rather than new logos. Net retention landed at 121%.</p>
  <ul>
    <li>Closed 14 new accounts, down from 19 last quarter.</li>
    <li>Gross margin held steady at 76%.</li>
    <li>Two enterprise deals slipped into Q3.</li>
  </ul>

  <h2>Numbers</h2>
  <table>
    <thead><tr><th>Metric</th><th>Q1</th><th>Q2</th><th>Change</th></tr></thead>
    <tbody>
      <tr><td>Revenue</td><td>$1.20M</td><td>$1.42M</td><td>+18%</td></tr>
      <tr><td>New accounts</td><td>19</td><td>14</td><td>-26%</td></tr>
      <tr><td>Net retention</td><td>114%</td><td>121%</td><td>+7pts</td></tr>
    </tbody>
  </table>

  <h2>Risks</h2>
  <blockquote>The biggest risk is concentration: our top three accounts now make up 41% of revenue.</blockquote>
  <p>We should diversify the pipeline in Q3 and revisit pricing for the mid-market segment.</p>
</body></html>`;

const r = await store.publish('demo', {
  title: 'Quarterly Update (demo)',
  html,
  summary: 'Seed demo document',
  author: { identity: 'agent', name: process.env.AGENT_NAME || 'Claude', session_id: 'seed' },
});

const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, '');
const token = process.env.REVIEWER_TOKEN || '<REVIEWER_TOKEN>';
console.log(`Seeded "demo" → v${r.version}`);
console.log(`Open:  ${base}/d/demo?token=${token}`);
