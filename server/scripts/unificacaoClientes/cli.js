#!/usr/bin/env node
// Offline por construção: nenhuma conexão de banco ou modo de escrita.
const fs = require('node:fs');
const { buildPlan } = require('./planner');
function main(argv = process.argv.slice(2)) {
  const flags = new Set(['--plan', '--validate', '--manifest', '--snapshot', '--output']);
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flags.has(flag) || options[flag] !== undefined) throw new Error('CLI_ARGUMENT_INVALID');
    if (flag === '--plan' || flag === '--validate') options[flag] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('CLI_ARGUMENT_MISSING');
      options[flag] = argv[++i];
    }
  }
  if (!!options['--plan'] === !!options['--validate'] || !options['--manifest'] || !options['--snapshot']) throw new Error('CLI_MODE_INVALID');
  const manifest = JSON.parse(fs.readFileSync(options['--manifest'], 'utf8'));
  const snapshot = JSON.parse(fs.readFileSync(options['--snapshot'], 'utf8'));
  const plan = buildPlan(snapshot, manifest);
  const result = options['--validate'] ? { ...plan.validation, productionReady: false, writeCapability: false } : plan;
  const output = JSON.stringify(result, null, 2) + '\n';
  if (options['--output']) {
    if ([options['--manifest'], options['--snapshot']].some(p => require('node:path').resolve(p) === require('node:path').resolve(options['--output']))) throw new Error('CLI_OUTPUT_OVERWRITES_INPUT');
    fs.writeFileSync(options['--output'], output, { mode: 0o600 });
  } else process.stdout.write(output);
  return options['--validate'] && !result.ok ? 2 : 0;
}
if (require.main === module) {
  try { process.exitCode = main(); }
  catch (e) { process.stderr.write(JSON.stringify({ ok: false, code: e.code || (/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message || '') ? e.message : 'CLI_FAILED') }) + '\n'); process.exitCode = 64; }
}
module.exports = { main };
