# Enforce external tool calls

NeuralOps v1.1 adds pre-dispatch adapters for MCP handlers and OpenAI Agents SDK function tools. Both use the existing Agent Control API: authorize the exact action, atomically consume its short-lived lease, then invoke the local tool function. An approval-required response, invalid lease, revoked identity, or unavailable backend means the function is not called.

These adapters protect only functions routed through the wrapper. They do not intercept arbitrary code, provider-hosted tools, subprocesses, or tools registered outside the guarded path. Keep credentials server-side and place real side effects behind a tool handler that the adapter directly wraps.

## Compatibility

| Integration | Version | Install | Adapter |
| --- | --- | --- | --- |
| MCP TypeScript server | `@modelcontextprotocol/server` 2.4.x (Node.js 20+) | Optional peer dependency | `@neuralops/sdk/mcp` `guardMcpTool` |
| OpenAI Agents SDK for Python | `openai-agents` 0.24.x | Optional `openai-agents` extra | `neuralops.guard_openai_tool` |

The SDK packages are versioned as `0.2.0` in this source tree. They are not yet published to npm or PyPI; install them from a clean clone using the commands below.

## Self-host locally

Start the app and API using the repository quickstart. Register an external identity in Agent Command Center with:

- Environment `dev` or `staging`
- Provider access containing `mcp` or `openai`, matching the integration used
- Permission matching the action: `metadata:read`, `write`, `shell:execute`, `browser:interact`, `external:post`, `secret:read`, or `destructive:execute`

Copy the one-time identity credential to a server-side environment variable. Never put it in an MCP client configuration checked into source control, a prompt, or a browser bundle.

## MCP demo

The runnable server is an in-memory simulation and does not write files or contact external services.

```powershell
cd examples/mcp
npm install
$env:NEURALOPS_API_URL = "http://localhost:8000"
$env:NEURALOPS_AGENT_IDENTITY_ID = "<identity id>"
$env:NEURALOPS_AGENT_CREDENTIAL = "<one-time credential>"
npx @modelcontextprotocol/inspector node index.mjs
```

Call `simulate_publish`. Without a current approval the handler is not invoked and no simulated publish occurs. Review the pending action in Agent Command Center, then call the same action again to exercise the one-use approval and lease. The adapter retains a pending idempotency key in process memory so that this approval-and-retry path addresses the same request. After it succeeds, revoke the identity in Agent Command Center and call it again: the wrapper denies the action before the handler runs.

The workspace starts in metadata-only mode. For an approval summary, an Owner or Admin can switch Reviewer context policy to `Redacted preview`. The adapter then sends only the callback's bounded `summary`, `resource`, and `impact` strings. The callback must redact its values. Raw tool arguments are hashed locally and are not sent in metadata-only mode; switching back clears stored previews.

## JavaScript adapter

```js
import { NeuralOps, AGENT_ACTIONS, AGENT_TOOL_CATEGORIES } from '@neuralops/sdk';
import { guardMcpTool } from '@neuralops/sdk/mcp';

server.registerTool('publish_report', schema, guardMcpTool(neuralops, {
  identityId: process.env.NEURALOPS_AGENT_IDENTITY_ID,
  toolName: 'publish_report',
  action: AGENT_ACTIONS.WRITE,
  toolCategory: AGENT_TOOL_CATEGORIES.WRITE,
  provider: 'mcp',
  environment: 'staging',
  createApprovalPreview: (args) => ({
    summary: 'Publish the reviewed report',
    resource: args.reportName,
    impact: 'One report will be published',
  }),
}, async (args) => publishReport(args)));
```

Pass a callback only when its output is safe for human review; callback output is not automatically scrubbed for arbitrary PII or business-confidential content. The backend rejects preview payloads unless workspace policy enables them and removes known credential patterns before persistence.

For orchestrators that reconstruct an approved call after process restart, configure `idempotencyKey(args, ...handlerContext)` to return a stable, non-secret operation identifier. NeuralOps hashes that value before sending it. Without a callback, the adapter preserves the pending request key in process memory for approve-then-retry, then creates a fresh key after successful execution.

## OpenAI Agents SDK for Python

This demo invokes the real SDK `FunctionTool` boundary directly, so it needs no model API key or external side-effect credentials:

```powershell
python -m pip install -e "sdk/python[openai-agents]"
$env:NEURALOPS_API_URL = "http://localhost:8000"
$env:NEURALOPS_AGENT_IDENTITY_ID = "<identity id>"
$env:NEURALOPS_AGENT_CREDENTIAL = "<one-time credential>"
python examples/openai-agents/demo.py
```

The first call prints that authorization was blocked before the simulated function ran. Approve the pending request in Agent Command Center, then rerun the printed command with the same `--call-id` to execute against the same approval. Revoke the identity and run the demo again with a new call ID; authorization must fail before the function runs.

For an agent that has already been created by your application, wrap its Python function and add the returned function tool to `Agent.tools`:

```python
from agents import Agent, Runner
from neuralops import NeuralOpsClient, guard_openai_tool

client = NeuralOpsClient(agent_credential=credential)
guarded_tool = guard_openai_tool(
    client,
    simulated_write,
    identity_id=identity_id,
    action="write",
    tool_category="write",
    provider="openai",
    environment="dev",
)
agent = Agent(name="governed-demo", instructions="Use the simulated write tool.", tools=[guarded_tool])
result = Runner.run_sync(agent, "Run the simulated write")
print(result.final_output)
```

That application-driven example uses whichever model provider and credentials your agent is configured with. The local boundary demo above does not call a model.

The Python extra is optional. The base SDK remains usable without installing the OpenAI Agents SDK. See [the Python SDK guide](../sdk/python/README.md) for preview policy and approval retry behavior.

## Operational boundaries

- High-risk actions require explicit approval. Do not interpret a pending request as permission to run.
- Authorization leases are single-use and bound to identity, action, tool category, operation, context hash, content hash, provider, environment, and idempotency key.
- The lease is consumed before the wrapped function starts. If the function crashes after consumption, reconcile the external side effect before requesting another action; do not blindly replay writes.
- Revocation blocks future authorization and consumption; it cannot undo an external side effect already started by a function.
- The SDK may retry idempotent authorization requests using the same key. Lease consumption is not replayed because its response may be ambiguous.
