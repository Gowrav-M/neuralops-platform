import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { NeuralOps, AGENT_ACTIONS, AGENT_TOOL_CATEGORIES } from '../../sdk/javascript/index.js';
import { guardMcpTool } from '../../sdk/javascript/mcp.js';

const credential = process.env.NEURALOPS_AGENT_CREDENTIAL;
const identityId = process.env.NEURALOPS_AGENT_IDENTITY_ID;
if (!credential || !identityId) {
  throw new Error('Set NEURALOPS_AGENT_CREDENTIAL and NEURALOPS_AGENT_IDENTITY_ID from the one-time credential flow.');
}

const neuralops = new NeuralOps({
  agentCredential: credential,
  baseUrl: process.env.NEURALOPS_API_URL || 'http://localhost:8000',
});

function createServer() {
  const server = new McpServer({ name: 'neuralops-governed-demo', version: '0.2.0' });
  server.registerTool(
    'simulate_publish',
    {
      title: 'Simulate publishing a document',
      description: 'A safe in-memory write simulation. It does not contact the network or modify files.',
      inputSchema: {
        documentName: z.string().min(1).max(120),
        body: z.string().min(1).max(2_000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    guardMcpTool(neuralops, {
      identityId,
      toolName: 'simulate_publish',
      action: AGENT_ACTIONS.WRITE,
      toolCategory: AGENT_TOOL_CATEGORIES.WRITE,
      provider: 'mcp',
      environment: process.env.NEURALOPS_ENVIRONMENT || 'dev',
      createApprovalPreview: ({ documentName }) => ({
        summary: 'Publish a document in the in-memory demo',
        resource: documentName,
        impact: 'No network or filesystem side effect',
      }),
    }, async ({ documentName }) => ({
      content: [{ type: 'text', text: `Simulated publish approved for ${documentName}; no external side effect occurred.` }],
    })),
  );
  return server;
}

void serveStdio(createServer);
console.error('NeuralOps MCP boundary demo ready on stdio. Tool calls require NeuralOps authorization.');
