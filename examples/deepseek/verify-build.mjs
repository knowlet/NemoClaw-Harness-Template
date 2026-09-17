// UNOFFICIAL candidate preflight executed inside the image build, not on the host.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
const expected = '0.1.6-alpha.1';
const command = (args) => execFileSync('/usr/local/bin/dsh', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 8388608, env: process.env });
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 5)) throw new Error('Candidate needs Node 24.5+');
const version = command(['--version']).trim();
if (!version.split(/\s+/).includes(expected)) throw new Error('DSH version differs from the source-reviewed candidate; review and requalify instead of bypassing');
// Initialize the shipped headless profile at build time without invoking a model.
command(['--profile', 'headless', '--dump-config']);
const filename = '/sandbox/.dsh/profiles/headless/package.json';
const profile = JSON.parse(await readFile(filename, 'utf8'));
if (!profile.dsh?.profile || !Array.isArray(profile.dsh.profile.bundles)) throw new Error('Upstream profile schema changed');
profile.dsh.profile.patchReload = 'startup';
await writeFile(filename, `${JSON.stringify(profile, null, 2)}\n`);
// Retain effective config for human review; successful composition does not prove plugin containment.
const composed = command(['--profile', 'headless', '--patch', '/etc/nha/managed.cordis.patch.yml', '--dump-config']);
await writeFile('/etc/nha/effective-config.review.yaml', composed);
console.log('UNOFFICIAL: version/profile/config composition checks passed. Live E2E qualification is still required.');
