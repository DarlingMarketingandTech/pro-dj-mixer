// Drives one REA MCP server session (stdio JSON-RPC) so Ghidra analyses mixxx.exe once and then
// answers every query. Writes each raw REA response to OUT_DIR for evidence.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REA = 'C:/Users/hoosi/AppData/Local/npm-cache/_npx/af752b90495482d7/node_modules/rea-agents/scripts/rea.mjs';
const TARGET = String.raw`C:\Program Files\Mixxx\mixxx.exe`;
const OUT_DIR = String.raw`C:\tools\rea-snapshots\mixxx-trace-2026-10-11-pdb`;
fs.mkdirSync(OUT_DIR, { recursive: true });

const env = {
  ...process.env,
  GHIDRA_INSTALL_DIR: String.raw`C:\tools\ghidra_12.1.4_PUBLIC`,
  JAVA_HOME: String.raw`C:\tools\jdk-21.0.12.1+1`,
  GHIDRA_HEADLESS_MAXMEM: '8G',
  REA_GHIDRA_STARTUP_TIMEOUT_MS: '3600000',
  REA_GHIDRA_SEED_FILE: String.raw`C:\tools\rea-snapshots\mixxx-2.5.6-pdb.seeds`,
};
const server = spawn(process.execPath, [REA, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => fs.appendFileSync(path.join(OUT_DIR, 'server.stderr.log'), d));

let nextId = 1;
const pending = new Map();
let buffer = '';
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
const send = (method, params) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const notify = (method, params) => server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let step = 0;
async function call(name, args, label) {
  const t0 = Date.now();
  const msg = await send('tools/call', { name, arguments: args });
  const file = path.join(OUT_DIR, `${String(++step).padStart(2, '0')}-${label}.json`);
  fs.writeFileSync(file, JSON.stringify(msg, null, 2));
  const text = msg.result?.content?.map((c) => c.text ?? '').join('') ?? '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  const isError = !!(msg.error || msg.result?.isError);
  log(`${label}: ${isError ? 'ERROR' : 'ok'} in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${path.basename(file)}`);
  return { isError, parsed, text };
}

/** Collect {name, address} pairs anywhere in a search result. */
function procedurePairs(value, acc = []) {
  if (Array.isArray(value)) value.forEach((v) => procedurePairs(v, acc));
  else if (value && typeof value === 'object') {
    const name = value.name ?? value.value ?? value.procedure;
    if (typeof name === 'string' && typeof value.address === 'string') acc.push({ name, address: value.address });
    Object.values(value).forEach((v) => procedurePairs(v, acc));
  }
  return acc;
}

// Workflow → [search pattern, exact method we want details for, details to fetch]
const TARGETS = [
  ['A-play', 'slotControlPlayRequest', 'EngineBuffer::slotControlPlayRequest', ['pseudo', 'callees']],
  ['A-play', 'processTrackLocked', 'EngineBuffer::processTrackLocked', ['callees']],
  ['A-play', 'calculateSpeed', 'RateControl::calculateSpeed', ['callers']],
  ['B-sync', 'calcSyncAdjustment', 'BpmControl::calcSyncAdjustment', ['pseudo', 'callers']],
  ['B-sync', 'calcSyncedRate', 'BpmControl::calcSyncedRate', ['callers', 'callees']],
  ['B-sync', 'determineBpmMultiplier', 'SyncControl::determineBpmMultiplier', ['pseudo', 'callers']],
  ['C-xfader', 'getXfadeGains', 'EngineXfader::getXfadeGains', ['pseudo', 'callers']],
  ['D-loop', 'findQuantizedBeatloopStart', 'LoopingControl::findQuantizedBeatloopStart', ['pseudo', 'callers']],
  ['D-loop', 'getNextSamples', 'ReadAheadManager::getNextSamples', ['callers', 'callees']],
];

try {
  await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code-mixxx-trace', version: '1' } });
  notify('notifications/initialized', {});
  log('server initialized; opening target (Ghidra analysis, ~15 min)');

  const opened = await call('open_binary', { path: TARGET, provider_id: 'ghidra' }, 'open_binary');
  if (opened.isError) throw new Error('open_binary failed: ' + opened.text.slice(0, 500));
  await call('binary_overview', {}, 'binary_overview');

  const summary = [];
  for (const [workflow, pattern, wanted, details] of TARGETS) {
    const found = await call('search_procedures', { pattern, mode: 'literal', case_sensitive: true }, `${workflow}-search-${pattern}`);
    const pairs = procedurePairs(found.parsed);
    // Seeded names are the full PDB names, so query by name when the search parse finds nothing.
    const exact = pairs.find((p) => p.name === wanted) ?? pairs.find((p) => p.name.endsWith(wanted)) ?? { name: wanted, address: wanted };
    const entry = { workflow, wanted, matches: pairs.map((p) => `${p.name} @ ${p.address}`), resolved: exact ?? null, details: {} };
    if (exact) {
      const proc = exact.address;
      for (const d of details) {
        const tool = { pseudo: 'procedure_pseudo_code', callers: 'procedure_callers', callees: 'procedure_callees' }[d];
        const r = await call(tool, { procedure: proc }, `${workflow}-${d}-${pattern}`);
        entry.details[d] = r.isError ? `ERROR: ${r.text.slice(0, 300)}` : `step ${String(step).padStart(2, '0')}`;
      }
    }
    summary.push(entry);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  log('done; summary.json written');
} catch (error) {
  log('FAILED', error.message);
  process.exitCode = 1;
} finally {
  try { await call('close_binary', {}, 'close_binary'); } catch { /* ignore */ }
  server.kill();
}
