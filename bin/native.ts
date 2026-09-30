// TypeScript source of truth; declarations are emitted by tsc.
/** UNOFFICIAL CLI for NemoClaw-native agent packaging. Not an NVIDIA tool. */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AdapterError, NOTICE, NATIVE_CONTRACT, scaffoldNativeAgent, installNativeAgent, verifyNativeAgent } from '../src/index.js';
import type { NativeAgentInput } from '../src/index.js';

const BOOLEAN_FLAGS = ['replace', 'allow-unsupported-upstream', 'help'] as const;
const VALUE_FLAGS = ['name', 'nemoclaw', 'display-name', 'description', 'harness', 'model', 'json'] as const;
type BooleanFlag = typeof BOOLEAN_FLAGS[number];
type ValueFlag = typeof VALUE_FLAGS[number];
type Flags = Partial<Record<BooleanFlag, true> & Record<ValueFlag, string>>;

function parse(args: string[]) {
  const positional: string[] = [], flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2);
    if ((!BOOLEAN_FLAGS.includes(key as BooleanFlag) && !VALUE_FLAGS.includes(key as ValueFlag)) || key in flags) throw new AdapterError('USAGE', 'Unknown or repeated option');
    if (BOOLEAN_FLAGS.includes(key as BooleanFlag)) flags[key as BooleanFlag] = true;
    else {
      if (args[i + 1] === undefined) throw new AdapterError('USAGE', 'Missing option value');
      flags[key as ValueFlag] = args[++i];
    }
  }
  return { positional, flags };
}

function help() {
  console.log(`${NOTICE}

Usage: nha native <action>
  init <directory> [--name NAME] [--display-name TEXT] [--description TEXT] [--model MODEL] [--harness echo|external]
  install <directory> --nemoclaw <checkout> [--replace] [--allow-unsupported-upstream]
  verify --nemoclaw <checkout> --name NAME [--json FILE] [--allow-unsupported-upstream]

Native packaging writes agents/<name>/ for ${NATIVE_CONTRACT.upstream}@${NATIVE_CONTRACT.revision}.
That layout is internal to the pinned upstream revision, not a public NVIDIA extension API.
init and install only touch the local filesystem; nothing is published.
`);
}

export async function nativeCommand(args: string[]) {
  const { positional, flags } = parse(args);
  const [action, directory] = positional;
  if (!action || flags.help) { help(); return; }
  if (action === 'init') {
    if (!directory) throw new AdapterError('USAGE', 'native init requires a destination');
    if (flags.harness !== undefined && flags.harness !== 'echo' && flags.harness !== 'external') throw new AdapterError('INVALID_MANIFEST', 'harness must be echo or external');
    const input: NativeAgentInput = {
      name: flags.name ?? path.basename(path.resolve(directory)),
      displayName: flags['display-name'],
      description: flags.description,
      model: flags.model,
      harness: flags.harness,
    };
    const result = await scaffoldNativeAgent(directory, input);
    console.log(JSON.stringify({ notice: NOTICE, native: true, directory: result.directory, agent: result.agent.name, files: result.files }, null, 2));
    return;
  }
  if (action === 'install') {
    if (!directory) throw new AdapterError('USAGE', 'native install requires a package directory');
    if (!flags.nemoclaw) throw new AdapterError('USAGE', 'native install requires --nemoclaw <checkout>');
    const result = await installNativeAgent(directory, {
      nemoclawRoot: flags.nemoclaw,
      replace: flags.replace === true,
      allowUnsupportedUpstream: flags['allow-unsupported-upstream'] === true,
    });
    console.log(JSON.stringify({ notice: NOTICE, installed: true, ...result }, null, 2));
    return;
  }
  if (action === 'verify') {
    if (!flags.nemoclaw || !flags.name) throw new AdapterError('USAGE', 'native verify requires --nemoclaw <checkout> and --name NAME');
    const report = await verifyNativeAgent({
      nemoclawRoot: flags.nemoclaw,
      name: flags.name,
      allowUnsupportedUpstream: flags['allow-unsupported-upstream'] === true,
    });
    if (flags.json) await writeFile(flags.json, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report, null, 2));
    if (!report.loaderAccepted) process.exitCode = 1;
    return;
  }
  throw new AdapterError('USAGE', 'Unknown native action; expected init, install, or verify');
}
