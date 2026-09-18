# Harness test kit — UNOFFICIAL

The SDK's `@knowlet/nemoclaw-harness-sdk/testing` entry point supplies a black-box contract suite. It tests your executable or invocation bridge; it does not implement an agent framework or certify isolation.

## Start with the generated project

```bash
node bin/nha.mjs init ./my-harness --name my-harness
cd my-harness
npm test
```

The generated `test/suite.json` has three deterministic echo cases: basic input, Traditional Chinese/emoji, and literal shell metacharacters. Replace the command in `test/harness.test.mjs` and the expectations when adding your Go, Python, Node, or other harness. Tests use temporary local workspace/home paths. `npm test` in a generated project executes trusted code locally, not in a new sandbox.

## A versioned, data-only suite

```json
{
  "version": "harness-suite/v1",
  "name": "my-harness",
  "cases": [
    {
      "name": "basic task",
      "task": "hello",
      "timeoutMs": 5000,
      "expect": { "stdout": "Echo: hello\n" }
    }
  ]
}
```

Each case has exactly one oracle: `stdout` (exact), `includes` (substring), or `errorCode` (a stable `AdapterError` code). Unknown fields, duplicate names, unsupported versions, oversized inputs, and invalid timeouts fail validation. There are at most 100 cases. Do not put executable JavaScript in the JSON file. The adapter command remains trusted executable input.

## CLI and CI reports

```bash
# Explicit host execution; adapter.local.json must point to your installed executable.
node bin/nha.mjs test test/suite.json --adapter adapter.local.json \
  --allow-host --json result.json --junit result.xml

# Inside an actual provisioned sandbox, with immutable managed configuration:
node /opt/nha/bin/nha.mjs test /opt/nha/test/suite.json \
  --adapter /etc/nha/adapter.json --managed \
  --json /sandbox/workspace/result.json --junit /sandbox/workspace/result.xml
```

Pass exactly one of `--allow-host` or `--managed`. The CLI exits 0 only when every case passes; failures and cancellations exit 1. Report files are created exclusively with mode 0600; an existing file is not overwritten. Ensure their parent directories already exist. Managed mode checks non-root Linux execution, Node 24.5+, and root-owned read-only configuration. Those checks alone do not establish an OpenShell sandbox.

## Integrate another framework

```js
import { runSuite, toJUnit } from '@knowlet/nemoclaw-harness-sdk/testing';

// Define framework.run in your own bridge; respect AbortSignal and bound its output.
const report = await runSuite(suite, {
  invoke: async (task, { signal }) => {
    const answer = await framework.run({ task, signal });
    return { stdout: answer.text, stderr: '', exitCode: 0 };
  },
});
console.log(toJUnit(report));
if (!report.ok) process.exitCode = 1;
```

Alternatively supply `{ adapter, cwd, home }` to invoke the SDK's actual subprocess runner. Do not supply both `adapter` and `invoke`. A bridge can call an SDK, HTTP service, or `nemoclaw <sandbox> exec`, but must handle its own transport, lifecycle, error translation, and cancellation. This project does not pretend to expose native bindings for every framework.

Cases run sequentially. Workspace/home are shared within a suite unless the bridge isolates them. Subprocess execution uses the SDK's process-group cleanup and output limit. The test-kit timeout bounds how long it waits for a custom bridge, but cannot forcibly terminate in-process code that ignores cancellation; run untrusted or uncooperative bridges in an outer process/sandbox. A synchronous infinite loop cannot be interrupted by a JavaScript timer.

## Deterministic inference fixture

```js
import { createInferenceClient } from '@knowlet/nemoclaw-harness-sdk';
import { createMockInferenceServer } from '@knowlet/nemoclaw-harness-sdk/testing';

const fixture = await createMockInferenceServer({ replies: ['FIRST', 'SECOND'] });
try {
  const client = createInferenceClient({
    model: 'fixture-model', baseUrl: fixture.baseUrl, development: true,
  });
  const response = await client.chat([{ role: 'user', content: 'test' }]);
  console.log(response.choices[0].message.content);
} finally {
  await fixture.close();
}
```

The fixture binds only to loopback on an ephemeral port and supports non-streaming Chat Completions and model listing. Replies may also be assistant messages with `tool_calls`, allowing deterministic tool-loop tests. The harness must execute the tool itself; the fixture does not. Exhausting the queue fails with HTTP 503. This is a mock model, not a real LLM or managed gateway.

## Native agent verification

`nha native verify --nemoclaw <checkout> --name <agent>` executes the checkout real compiled loader and reports `listed`, `loaderAccepted`, and the resolved Dockerfile. `loaderAccepted: true` means NemoClaw resolves the agent and selects its Dockerfile; it is not a deployment. Deployment evidence comes from the [runtime integration workflow](../.github/workflows/runtime-integration.yml), which onboards the agent, creates the sandbox, and executes the harness inside it.

## Reporting and assurance levels

JSON/JUnit omit tasks, expected answers, stdout/stderr bodies, and exception messages. Reports retain case names, timings, stable error codes, sizes, and output hashes. Use non-sensitive names. Hashes are not anonymization of predictable low-entropy outputs.

`execution` distinguishes subprocess from custom bridge execution. `sandboxVerified` is always false because a black-box answer cannot attest the outer environment. A deployment workflow must provide separate evidence.

| Layer | What it proves |
| --- | --- |
| SDK regression tests | Input validation, process execution, cancellation, output/error limits |
| Generated harness suite | Your configured command meets the declared task/output contract |
| Loopback HTTP fixture | Wire handling and deterministic response/tool-call behavior |
| Docker image checks | The built image boots and has the required files/identity |
| Actual NemoClaw/OpenShell workflow | Only the real deployment and policy assertions that passed in that run |
| Real-model evaluation | Not supplied; use your chosen model, task set, and independent oracle |

See [validation evidence](VALIDATION.md) and the [runtime workflow](../.github/workflows/runtime-integration.yml). Failed deployment checks are not converted into successful SDK checks.
