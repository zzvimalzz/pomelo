// SPDX-License-Identifier: AGPL-3.0-or-later
// The one list of test suites, used by the npm scripts and by CI. Runs them one after another, kills one that hangs, and reports
// the result: a table, GitHub annotations and a step summary in CI, JUnit XML on request.
//   node test/run.js [--tier=unit,integration,pdf] [--only=jobs,matrix] [--timeout=<seconds>] [--junit=<file>]
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

// unit: plain Node, no engines. integration: hosted in Electron (skips what needs LibreOffice, Pandoc or the PDF engine).
// pdf: needs the Python PDF engine. ui: opens real windows, so leave the mouse alone while it runs.
// nightly: downloads and installs for real; never part of the default run.
// `timeout` is in seconds. The order here is the order they run in.
const SUITES = [
  { name: 'jobs', file: 'unit/jobs/jobs.test.js', tier: 'unit' },
  { name: 'helper', file: 'integration/gesture/input-helper.test.js', tier: 'unit', timeout: 30 },
  { name: 'engine-cli', file: 'unit/engine-setup/cli.test.js', tier: 'unit' },
  { name: 'installer', file: 'unit/engine-setup/installer.test.js', tier: 'unit' },
  { name: 'uninstall', file: 'unit/uninstall/uninstall.test.js', tier: 'unit' },
  { name: 'autoupdate', file: 'unit/updates/auto-check.test.js', tier: 'unit' },
  { name: 'updater', file: 'unit/updates/check.test.js', tier: 'unit' },
  { name: 'updateinstall', file: 'unit/updates/install.test.js', tier: 'unit' },
  { name: 'ipc', file: 'unit/app/ipc.test.js', tier: 'unit' },
  { name: 'routing', file: 'unit/conversion/routing.test.js', tier: 'unit' },
  { name: 'kit-and-catalog', file: 'unit/conversion/kit-and-catalog.test.js', tier: 'unit' },
  { name: 'registry', file: 'unit/conversion/registry.test.js', tier: 'unit' },
  { name: 'dev-tools', file: 'unit/tools/dev-tools.test.js', tier: 'unit' },
  { name: 'paths', file: 'unit/shared/paths.test.js', tier: 'unit' },
  { name: 'fs-process', file: 'unit/shared/fs-process.test.js', tier: 'unit' },
  { name: 'text', file: 'unit/shared/text.test.js', tier: 'unit' },
  { name: 'app-start', file: 'integration/app/start.test.js', tier: 'integration', timeout: 120 },
  { name: 'matrix', file: 'integration/conversion/matrix.test.js', tier: 'integration', electron: true, timeout: 600 },
  { name: 'edge-cases', file: 'integration/conversion/edge-cases.test.js', tier: 'integration', electron: true, timeout: 300 },
  { name: 'pdf-layout', file: 'integration/conversion/pdf-layout.test.js', tier: 'pdf', timeout: 300 },
  { name: 'pdf-formats', file: 'integration/conversion/pdf-formats.test.js', tier: 'pdf', timeout: 300 },
  { name: 'pipeline', file: 'ui/pipeline.js', tier: 'ui', electron: true },
  { name: 'real-python', file: 'integration/engine-setup/real-python.test.js', tier: 'nightly', timeout: 900 },
  { name: 'overlay-shot', file: 'ui/overlay-shot.js', tier: 'ui', electron: true },
  { name: 'toast-shot', file: 'ui/toast-shot.js', tier: 'ui', electron: true },
  { name: 'settings-shot', file: 'ui/settings-shot.js', tier: 'ui', electron: true },
];
const DEFAULT_TIMEOUT = 120;

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const inCI = !!process.env.GITHUB_ACTIONS;
const escapeData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeXml = (s) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

function runSuite(suite, limit) {
  return new Promise((resolve) => {
    // The Electron binary is found through require('electron'), which gives its path under plain Node.
    // ELECTRON_RUN_AS_NODE (set by some editors) would make it behave as Node and break the Electron suites.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(suite.electron ? require('electron') : process.execPath, [path.join(__dirname, suite.file)], { cwd: root, env });
    let out = '';
    let timedOut = false;
    let done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, timedOut, out }); };
    const take = (chunk) => { process.stdout.write(chunk); out += chunk; };
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding('utf8'); stream.on('data', take); }
    child.on('close', finish);
    const timer = setTimeout(() => {
      timedOut = true;
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });   // Electron leaves helper processes behind
      setTimeout(() => finish(null), 5000);
    }, limit * 1000);
  });
}

function tally(out) {
  const checks = [];
  let skipped = 0;
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(ok|FAIL)\s+(.*)$/.exec(line);
    if (m) checks.push({ ok: m[1] === 'ok', name: m[2].trim() });
    else if (/^\s+skip\b|\bskipped\s*$/.test(line)) skipped++;
  }
  return { checks, skipped };
}

function junit(results) {
  const cases = (r) => [
    ...r.checks.map((c) => `<testcase classname="${r.name}" name="${escapeXml(c.name)}">${c.ok ? '' : '<failure message="check failed"/>'}</testcase>`),
    ...(r.problem ? [`<testcase classname="${r.name}" name="suite"><failure message="${escapeXml(r.problem)}"/></testcase>`] : []),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${results.map((r) => `<testsuite name="${r.name}" tests="${r.checks.length + (r.problem ? 1 : 0)}" failures="${r.failures + (r.problem ? 1 : 0)}" skipped="${r.skipped}" time="${(r.ms / 1000).toFixed(1)}">\n${cases(r).join('\n')}\n</testsuite>`).join('\n')}\n</testsuites>\n`;
}

(async () => {
  const only = arg('only')?.split(',');
  const tiers = (arg('tier') || 'unit,integration,pdf').split(',');
  const unknown = (only || []).filter((n) => !SUITES.some((s) => s.name === n));
  if (unknown.length) { console.error(`unknown suite: ${unknown.join(', ')}. Known: ${SUITES.map((s) => s.name).join(', ')}`); process.exit(2); }
  const chosen = SUITES.filter((s) => (only ? only.includes(s.name) : tiers.includes(s.tier)));
  if (!chosen.length) { console.error('no suites selected'); process.exit(2); }
  const results = [];

  for (const suite of chosen) {
    const limit = Number(arg('timeout')) || suite.timeout || DEFAULT_TIMEOUT;
    console.log(`${inCI ? `::group::${suite.name}\n` : ''}=== ${suite.name} (${suite.file}, limit ${limit}s)`);
    const t0 = Date.now();
    const { code, timedOut, out } = await runSuite(suite, limit);
    const { checks, skipped } = tally(out);
    const failures = checks.filter((c) => !c.ok).length;
    let problem = '';
    if (timedOut) problem = `timed out after ${limit}s and was killed`;
    else if (code !== 0 && !failures) problem = `exited with code ${code}`;
    results.push({ ...suite, checks, skipped, failures, problem, ms: Date.now() - t0, passed: !problem && !failures && code === 0 });
    if (inCI) console.log('::endgroup::');
  }

  console.log('\n' + 'suite'.padEnd(19) +'result'.padEnd(9) + 'ok'.padStart(5) + 'FAIL'.padStart(6) + 'skip'.padStart(6) + 'time'.padStart(8));
  for (const r of results) console.log(r.name.padEnd(19) + (r.passed ? 'passed' : 'FAILED').padEnd(9) + String(r.checks.length - r.failures).padStart(5) + String(r.failures).padStart(6) + String(r.skipped).padStart(6) + `${(r.ms / 1000).toFixed(1)}s`.padStart(8));
  const total = (key) => results.reduce((n, r) => n + (key === 'ok' ? r.checks.length - r.failures : r[key]), 0);
  console.log(`total: ${total('ok')} ok, ${total('failures')} FAIL, ${total('skipped')} skipped`);
  for (const r of results.filter((x) => x.skipped)) console.log(`  note: ${r.name} skipped ${r.skipped} (a skip is not a pass)`);

  if (inCI) {
    for (const r of results) {
      for (const c of r.checks.filter((x) => !x.ok)) console.log(`::error title=${r.name}::${escapeData(c.name)}`);
      if (r.problem) console.log(`::error title=${r.name}::${escapeData(r.problem)}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = results.map((r) => `| ${r.name} | ${r.passed ? 'passed' : '**FAILED**'} | ${r.checks.length - r.failures} | ${r.failures} | ${r.skipped} | ${(r.ms / 1000).toFixed(1)} s |`);
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Tests: ${tiers.join(', ')}\n\n| Suite | Result | ok | FAIL | skipped | Time |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\n`);
    }
  }
  const junitFile = arg('junit');
  if (junitFile) { fs.mkdirSync(path.dirname(path.resolve(junitFile)), { recursive: true }); fs.writeFileSync(junitFile, junit(results)); }

  process.exit(results.every((r) => r.passed) ? 0 : 1);
})();
