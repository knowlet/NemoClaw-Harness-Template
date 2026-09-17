// UNOFFICIAL EXPERIMENTAL build-context generator. Never installs or runs DSH on the host.
import { cp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { scaffold, defineAdapter, assertImageDigest, renderDeepSeekPatch, NOTICE } from '../../src/index.mjs';
const [destination, model, runtimeImage] = process.argv.slice(2);
if (!destination || !model || !runtimeImage || process.argv.length !== 5) {
  console.error('Usage: node examples/deepseek/prepare.mjs NEW_DIRECTORY MODEL REVIEWED_DSH_IMAGE@sha256:DIGEST');
  process.exit(1);
}
try {
  assertImageDigest(runtimeImage);
  const created = await scaffold(destination, { name: 'deepseek-headless', model });
  const dir = created.directory;
  const adapter = structuredClone(created.adapter);
  adapter.metadata.displayName = 'DeepSeek Harness (unofficial experimental adapter)';
  adapter.runtime.command = ['/usr/local/bin/node', '/opt/nha/deepseek-launch.mjs'];
  adapter.state.home = '/sandbox/.dsh';
  adapter.state.persist = ['sessions', 'storages', 'attachments'];
  adapter.state.reconstruct = [];
  adapter.env = { DSH_HOME: '/sandbox/.dsh', DSH_TELEMETRY_DISABLED: '1' };
  defineAdapter(adapter);
  const write = (name, value) => writeFile(path.join(dir, name), value);
  await write('adapter.json', `${JSON.stringify(adapter, null, 2)}\n`);
  await write('managed.cordis.patch.yml', renderDeepSeekPatch(adapter));
  await cp(fileURLToPath(new URL('launch.mjs', import.meta.url)), path.join(dir, 'deepseek-launch.mjs'));
  await cp(fileURLToPath(new URL('verify-build.mjs', import.meta.url)), path.join(dir, 'verify-build.mjs'));
  await write('source-review.json', `${JSON.stringify({ unofficial: true, status: 'experimental-not-qualified', sourceReviewed: '0d1f50007f9bca3f52b06e1c3074fa14d5fb0720', sourceVersion: '0.1.6-alpha.1', runtimeImage, warning: 'Source review and version checks are not provenance attestation or E2E qualification.' }, null, 2)}\n`);
  await write('policy.yaml', `# UNOFFICIAL EXPERIMENTAL. No broad write permission to DSH_HOME.\nversion: 1\nfilesystem_policy:\n  include_workdir: false\n  read_only: [/usr, /lib, /etc, /opt, /proc, /dev/urandom, /sandbox/.dsh]\n  read_write: [/sandbox/.dsh/sessions, /sandbox/.dsh/storages, /sandbox/.dsh/attachments, /sandbox/workspace, /tmp, /dev/null]\nlandlock:\n  compatibility: hard_requirement\nnetwork_policies: {}\n`);
  await write('Dockerfile', `# UNOFFICIAL EXPERIMENTAL. Base must provide /usr/local/bin/dsh and Node 24.5+.\nFROM ${runtimeImage}\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends ca-certificates iproute2 \\
    && rm -rf /var/lib/apt/lists/*\nCOPY --chown=root:root . /opt/nha/\nENV DSH_HOME=/sandbox/.dsh DSH_TELEMETRY_DISABLED=1 NODE_USE_ENV_PROXY=1\nRUN mkdir -p /etc/nha /sandbox/.dsh /sandbox/workspace \\
    && cp /opt/nha/adapter.json /etc/nha/adapter.json \\
    && cp /opt/nha/managed.cordis.patch.yml /etc/nha/managed.cordis.patch.yml \\
    && node /opt/nha/verify-build.mjs \\
    && chmod -R go-w /opt/nha /etc/nha \\
    && chmod 0444 /etc/nha/*.json /etc/nha/*.yml \\
    && chown -R root:root /sandbox/.dsh \\
    && find /sandbox/.dsh -type d -exec chmod 0755 {} + \\
    && find /sandbox/.dsh -type f -exec chmod 0444 {} + \\
    && mkdir -p /sandbox/.dsh/sessions /sandbox/.dsh/storages /sandbox/.dsh/attachments \\
    && chown -R 1000:1000 /sandbox/.dsh/sessions /sandbox/.dsh/storages /sandbox/.dsh/attachments /sandbox/workspace\nLABEL dev.knowlet.nha.unofficial="true" dev.knowlet.nha.status="experimental-not-qualified"\nUSER 1000:1000\nWORKDIR /sandbox/workspace\nENTRYPOINT ["/usr/local/bin/node", "/opt/nha/bin/nha.mjs", "exec", "/etc/nha/adapter.json", "--managed"]\n`);
  await write('README.md', await readFile(fileURLToPath(new URL('README.md', import.meta.url)), 'utf8'));
  console.log(`${NOTICE}\nCreated experimental DSH build context: ${dir}\nNo runtime was installed, built, or qualified.`);
} catch (error) {
  console.error(error.code ?? 'PREPARE_FAILED');
  process.exitCode = 1;
}
