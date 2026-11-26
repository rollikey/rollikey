import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type pg from 'pg';

/**
 * Built-in offline GitHub sandbox: a tiny GitHub-REST-compatible server (the subset the
 * Rollikey connector uses) backed by Postgres tables, so every process shares one state.
 * It listens on 127.0.0.1 only and never talks to github.com.
 */
const REPO = 'rollikey-sandbox/demo';
export const sha = (s: string) => createHash('sha1').update(s).digest('hex');

export async function seedGitHubSandbox(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query('SELECT 1 FROM sandbox_gh_items WHERE repo = $1 LIMIT 1', [REPO]);
  if (rows.length) return;
  for (let n = 1; n <= 12; n++) {
    await pool.query(
      `INSERT INTO sandbox_gh_items (repo, number, kind, title, body, labels) VALUES ($1, $2, 'issue', $3, $4, $5) ON CONFLICT DO NOTHING`,
      [REPO, n, `Sandbox issue #${n}`, `Body of sandbox issue ${n}.`, JSON.stringify(n % 2 ? ['bug'] : ['enhancement'])],
    );
  }
  for (let n = 13; n <= 15; n++) {
    await pool.query(
      `INSERT INTO sandbox_gh_items (repo, number, kind, title, body, base, head) VALUES ($1, $2, 'pull', $3, $4, 'main', $5) ON CONFLICT DO NOTHING`,
      [REPO, n, `Sandbox PR #${n}`, `Body of sandbox PR ${n}.`, `feature/pr-${n}`],
    );
  }
  for (const [name, prot] of [['main', true], ['develop', false], ['feature/login', false], ['feature/billing', false], ['feature/search', false]] as const) {
    await pool.query(`INSERT INTO sandbox_gh_branches (repo, name, sha, protected) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [REPO, name, sha(`${REPO}:${name}`), prot]);
  }
}

const issueJson = (r: any, repo: string) => ({
  number: r.number,
  title: r.title,
  body: r.body,
  state: r.state,
  labels: (r.labels as string[]).map((name) => ({ name })),
  assignees: (r.assignees as string[]).map((login) => ({ login })),
  milestone: r.milestone === null ? null : { number: r.milestone },
  updated_at: r.updated_at,
  html_url: `http://127.0.0.1/${repo}/${r.kind === 'pull' ? 'pull' : 'issues'}/${r.number}`,
  ...(r.kind === 'pull' ? { base: { ref: r.base }, head: { ref: r.head }, pull_request: {} } : {}),
});

export function createGitHubSandbox(pool: pg.Pool): Server {
  return createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const m = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(url.pathname);
      if (!m) return send(404, { message: 'Not Found' });
      const repo = decodeURIComponent(m[1]!);
      const rest = m[2]!;
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      await seedGitHubSandbox(pool);

      let g: RegExpExecArray | null;
      if ((g = /^(issues|pulls)\/(\d+)$/.exec(rest))) {
        const kind = g[1] === 'pulls' ? 'pull' : 'issue';
        const number = Number(g[2]);
        const get = async () => (await pool.query('SELECT * FROM sandbox_gh_items WHERE repo=$1 AND number=$2', [repo, number])).rows[0];
        const row = await get();
        // GitHub serves PRs through the issues endpoints too.
        if (!row || (g[1] === 'pulls' && row.kind !== 'pull')) return send(404, { message: 'Not Found' });
        if (req.method === 'GET') return send(200, issueJson(row, repo));
        if (req.method === 'PATCH') {
          const sets: string[] = [];
          const vals: unknown[] = [repo, number];
          const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
          if ('title' in body) add('title', body.title);
          if ('body' in body) add('body', body.body);
          if ('state' in body) { if (!['open', 'closed'].includes(body.state)) return send(422, { message: 'Validation Failed' }); add('state', body.state); }
          if ('labels' in body) add('labels', JSON.stringify(body.labels));
          if ('assignees' in body) add('assignees', JSON.stringify(body.assignees));
          if ('milestone' in body) add('milestone', body.milestone);
          if ('base' in body && row.kind === 'pull') add('base', body.base);
          if (sets.length) await pool.query(`UPDATE sandbox_gh_items SET ${sets.join(', ')}, updated_at = now() WHERE repo=$1 AND number=$2`, vals);
          return send(200, issueJson(await get(), repo));
        }
        void kind;
        return send(405, { message: 'Method Not Allowed' });
      }
      if ((g = /^issues$/.exec(rest)) && req.method === 'GET') {
        const { rows } = await pool.query(`SELECT * FROM sandbox_gh_items WHERE repo=$1 ORDER BY number`, [repo]);
        return send(200, rows.map((r) => issueJson(r, repo)));
      }
      if ((g = /^branches\/(.+)$/.exec(rest)) && req.method === 'GET') {
        const name = decodeURIComponent(g[1]!);
        const { rows } = await pool.query('SELECT * FROM sandbox_gh_branches WHERE repo=$1 AND name=$2', [repo, name]);
        return rows[0] ? send(200, { name, commit: { sha: rows[0].sha }, protected: rows[0].protected }) : send(404, { message: 'Branch not found' });
      }
      if ((g = /^git\/refs\/heads\/(.+)$/.exec(rest)) && req.method === 'DELETE') {
        const name = decodeURIComponent(g[1]!);
        const r = await pool.query('DELETE FROM sandbox_gh_branches WHERE repo=$1 AND name=$2 AND protected = false', [repo, name]);
        if (r.rowCount) return send(204, undefined);
        const exists = (await pool.query('SELECT 1 FROM sandbox_gh_branches WHERE repo=$1 AND name=$2', [repo, name])).rowCount;
        return exists ? send(422, { message: 'Cannot delete protected branch' }) : send(422, { message: 'Reference does not exist' });
      }
      if (rest === 'git/refs' && req.method === 'POST') {
        const name = String(body.ref ?? '').replace(/^refs\/heads\//, '');
        if (!name || !/^[0-9a-f]{40}$/.test(String(body.sha ?? ''))) return send(422, { message: 'Validation Failed' });
        const r = await pool.query('INSERT INTO sandbox_gh_branches (repo, name, sha) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [repo, name, body.sha]);
        return r.rowCount ? send(201, { ref: `refs/heads/${name}`, object: { sha: body.sha } }) : send(422, { message: 'Reference already exists' });
      }
      return send(404, { message: 'Not Found' });
    } catch (err) {
      return send(500, { message: (err as Error).message });
    }
  });
}

/** Start the sandbox unless another Rollikey process already serves it on the same port. */
export function ensureGitHubSandbox(pool: pg.Pool, port: number): Promise<Server | null> {
  return new Promise((resolve, reject) => {
    const server = createGitHubSandbox(pool);
    server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' ? resolve(null) : reject(err)));
    server.listen(port, '127.0.0.1', () => { server.unref(); resolve(server); });
  });
}
