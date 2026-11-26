import { createRollikey } from '../engine/index.js';
import { runFiveToolDrill } from '../drill/five-tool.js';

const sp = createRollikey({ log: () => {} });
try {
  const r = await runFiveToolDrill(sp);
  process.exitCode = r.passed ? 0 : 1;
} finally {
  await sp.close();
}
