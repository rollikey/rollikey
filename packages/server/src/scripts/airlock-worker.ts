import { createRollikey } from '../engine/index.js';

// Standalone airlock release worker. Safe to run alongside the MCP server's
// in-process worker: releases are claimed atomically.
const sp = createRollikey({ log: (m) => console.log(`[airlock] ${m}`) });
const worker = sp.startAirlockWorker(1000);
console.log(`[airlock] worker running (hold ${sp.config.airlock.holdSeconds}s, SMTP ${sp.config.smtp.host}:${sp.config.smtp.port})`);

const stop = async () => {
  await worker.stop();
  await sp.close();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
