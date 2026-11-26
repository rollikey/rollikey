import pg from 'pg';
import { config } from '../config.js';
import { migrate } from './migrate.js';

const TOTAL = 5_000;
const BATCH = 1_000;

// Deterministic PRNG so every seed produces identical data (handy for revert tests).
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ada', 'Grace', 'Alan', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken', 'Radia', 'Tim',
  'Frances', 'John', 'Hedy', 'Edsger', 'Katherine', 'Guido', 'Sophie', 'Bjarne', 'Anita', 'Donald'];
const LAST = ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson',
  'Perlman', 'Berners-Lee', 'Allen', 'McCarthy', 'Lamarr', 'Dijkstra', 'Johnson', 'van Rossum', 'Wilson',
  'Stroustrup', 'Borg', 'Knuth'];

function weighted<T>(rand: () => number, items: [T, number][]): T {
  let r = rand() * items.reduce((s, [, w]) => s + w, 0);
  for (const [item, w] of items) if ((r -= w) < 0) return item;
  return items[items.length - 1]![0];
}

async function seed() {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  try {
    await migrate(pool);
    const rand = mulberry32(42);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('TRUNCATE customers RESTART IDENTITY');
      for (let start = 0; start < TOTAL; start += BATCH) {
        const values: unknown[] = [];
        const tuples: string[] = [];
        for (let i = start; i < Math.min(start + BATCH, TOTAL); i++) {
          const first = FIRST[Math.floor(rand() * FIRST.length)]!;
          const last = LAST[Math.floor(rand() * LAST.length)]!;
          const plan = weighted(rand, [['free', 50], ['starter', 25], ['pro', 18], ['enterprise', 7]]);
          const status = weighted(rand, [['active', 82], ['past_due', 10], ['suspended', 4], ['cancelled', 4]]);
          const balance = plan === 'free' ? 0 : Math.floor(rand() * (plan === 'enterprise' ? 500_000 : 50_000));
          const email = `${first}.${last}.${i + 1}@example.test`.toLowerCase().replace(/[^a-z0-9.@-]/g, '');
          const params = [`${first} ${last}`, email, plan, balance, status];
          tuples.push('(' + params.map((_, k) => '$' + (values.length + k + 1)).join(', ') + ')');
          values.push(...params);
        }
        await client.query(
          `INSERT INTO customers (name, email, plan, balance_cents, status) VALUES ${tuples.join(', ')}`,
          values,
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM customers');
    console.log(`Seeded customers: ${rows[0]!.n} rows (deterministic, seed=42).`);
  } finally {
    await pool.end();
  }
}

seed().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
