// Copies non-TypeScript runtime assets (dashboard HTML + logo) next to the compiled JS.
import { cpSync } from 'node:fs';
cpSync(new URL('../src/dashboard/public', import.meta.url), new URL('../dist/dashboard/public', import.meta.url), { recursive: true });
