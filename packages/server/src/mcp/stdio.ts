#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRollikey } from '../engine/index.js';
import { createMcpServer } from './server.js';

// stdout carries the MCP protocol: every log line goes to stderr.
const sp = createRollikey();
const worker = sp.config.airlock.runWorker ? sp.startAirlockWorker() : null;

const handle = serveStdio(() => createMcpServer(sp), {
  onerror: (err) => console.error('[rollikey] mcp error:', err),
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await worker?.stop();
  await handle.close().catch(() => {});
  await sp.close();
}
process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.error(`[rollikey] MCP server on stdio (airlock worker: ${worker ? 'on' : 'off'})`);
