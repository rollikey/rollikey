import type pg from 'pg';
import { z } from 'zod';
import {
  RollikeyError, assertRunId, completeAction, evaluateBulk, noteActionError, recordAction, type SnapshotRow,
} from './ledger.js';

const nameRe = /^[A-Za-z0-9_.-]{1,100}$/;
const repoPart = z.string().regex(nameRe);
const patchSchema = z.object({
  title: z.string().min(1).max(256).optional(),
  body: z.string().max(65_536).nullable().optional(),
  state: z.enum(['open', 'closed']).optional(),
  labels: z.array(z.string()).max(100).optional(),
  base: z.string().optional(),
});
const target = { owner: repoPart.optional(), repo: repoPart.optional() };

export const githubUpdateRequestSchema = z.object({
  runId: z.string(),
  ...target,
  numbers: z.array(z.number().int().positive()).min(1).max(500),
  patch: patchSchema.refine((p) => Object.keys(p).length > 0, { message: 'patch needs at least one field' }),
});
export const githubDeleteBranchesSchema = z.object({
  runId: z.string(),
  ...target,
  branches: z.array(z.string().min(1).max(255)).min(1).max(500),
});
export type GitHubUpdateRequest = z.input<typeof githubUpdateRequestSchema>;
export type GitHubDeleteBranchesRequest = z.input<typeof githubDeleteBranchesSchema>;

export type GitHubResult =
  | { status: 'applied'; runId: string; seq: number; snapshotId: string; repo: string; items: number; numbers?: number[]; branches?: string[]; amountCents: 0 }
  | { status: 'blocked'; runId: string; seq: number; snapshotId: string; reason: string; amountCents: 0 };

export interface GitHubDeps {
  pool: pg.Pool;
  /** https://api.github.com (live, GITHUB_TOKEN set) or the local sandbox URL. */
  apiUrl: string;
  token: string;
  defaultRepo: string;
  maxBulkItems: number;
  protectedBranches: readonly string[];
}

interface ItemState { number: number; title: string; body: string | null; state: string; labels: string[]; base?: string }
interface BranchState { name: string; sha: string; protected: boolean }

export class GitHubError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** GitHub connector. Same REST code path for live GitHub and the offline sandbox. */
export class GitHubProxy {
  constructor(private readonly deps: GitHubDeps) {}

  get live(): boolean { return Boolean(this.deps.token); }

  private repoOf(owner?: string, repo?: string): string {
    if (owner && repo) return `${owner}/${repo}`;
    if (owner || repo) throw new RollikeyError('invalid_repo', 'Provide both owner and repo, or neither');
    return this.deps.defaultRepo;
  }

  private async api<T>(method: string, repo: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.deps.apiUrl}/repos/${repo}/${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'rollikey',
        ...(this.deps.token ? { authorization: `Bearer ${this.deps.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) throw new GitHubError(res.status, `GitHub ${method} ${path}: ${res.status} ${json.message ?? ''}`.trim());
    return json as T;
  }

  /** Public so drills / tests can read live state straight from the (sandbox) API. */
  async readItem(repo: string, number: number, kind: 'issue' | 'pull'): Promise<ItemState> {
    const j = await this.api<any>('GET', repo, `${kind === 'pull' ? 'pulls' : 'issues'}/${number}`);
    return {
      number: j.number, title: j.title, body: j.body ?? null, state: j.state,
      labels: (j.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)),
      ...(kind === 'pull' ? { base: j.base?.ref } : {}),
    };
  }
  async readBranch(repo: string, name: string): Promise<BranchState | null> {
    try {
      const j = await this.api<any>('GET', repo, `branches/${encPath(name)}`);
      return { name, sha: j.commit.sha, protected: Boolean(j.protected) };
    } catch (e) { if (e instanceof GitHubError && e.status === 404) return null; throw e; }
  }
  /** Fixture cleanup only (tests/drills): deletes a branch WITHOUT ledger or gate. Never exposed to agents. */
  async rawDeleteBranch(repo: string, name: string): Promise<void> {
    await this.api('DELETE', repo, `git/refs/heads/${encPath(name)}`).catch(() => {});
  }
  async createBranch(repo: string, name: string, sha: string): Promise<void> {
    await this.api('POST', repo, 'git/refs', { ref: `refs/heads/${name}`, sha });
  }

  async updateItems(kind: 'issue' | 'pull', input: GitHubUpdateRequest): Promise<GitHubResult> {
    const req = githubUpdateRequestSchema.parse(input);
    assertRunId(req.runId);
    const repo = this.repoOf(req.owner, req.repo);
    const numbers = [...new Set(req.numbers)];
    const actionType = kind === 'pull' ? 'github.pr_update' : 'github.issue_update';
    const reason = evaluateBulk(numbers.length, this.deps.maxBulkItems, kind === 'pull' ? 'pull requests' : 'issues');
    if (reason) {
      const snap = await recordAction(this.deps.pool, { runId: req.runId, actionType, target: repo, status: 'blocked', request: req, beforeState: { repo, kind, items: [] }, rowsAffected: numbers.length, amountCents: 0, blockReason: reason });
      return { status: 'blocked', runId: req.runId, seq: snap.seq, snapshotId: snap.id, reason, amountCents: 0 };
    }
    if (kind === 'issue' && req.patch.base) throw new RollikeyError('invalid_patch', '"base" only applies to pull requests');
    // Pre-flight snapshot of every item that will be edited.
    const items: ItemState[] = [];
    for (const n of numbers) items.push(await this.readItem(repo, n, kind));
    const snap = await recordAction(this.deps.pool, { runId: req.runId, actionType, target: repo, status: 'pending', request: req, beforeState: { repo, kind, items }, rowsAffected: items.length, amountCents: 0 });
    const done: ItemState[] = [];
    try {
      for (const n of numbers) {
        await this.api('PATCH', repo, `${kind === 'pull' ? 'pulls' : 'issues'}/${n}`, req.patch);
        done.push(await this.readItem(repo, n, kind));
      }
      await completeAction(this.deps.pool, snap.id, { repo, kind, items: done });
      return { status: 'applied', runId: req.runId, seq: snap.seq, snapshotId: snap.id, repo, items: done.length, numbers, amountCents: 0 };
    } catch (err) {
      // Partial progress stays 'pending' so revert() restores everything from before_state.
      await noteActionError(this.deps.pool, snap.id, (err as Error).message, { repo, kind, items: done });
      throw err;
    }
  }

  async deleteBranches(input: GitHubDeleteBranchesRequest): Promise<GitHubResult> {
    const req = githubDeleteBranchesSchema.parse(input);
    assertRunId(req.runId);
    const repo = this.repoOf(req.owner, req.repo);
    const names = [...new Set(req.branches)];
    const blockedWith = async (reason: string): Promise<GitHubResult> => {
      const snap = await recordAction(this.deps.pool, { runId: req.runId, actionType: 'github.branch_delete', target: repo, status: 'blocked', request: req, beforeState: { repo, branches: [] }, rowsAffected: names.length, amountCents: 0, blockReason: reason });
      return { status: 'blocked', runId: req.runId, seq: snap.seq, snapshotId: snap.id, reason, amountCents: 0 };
    };
    const bulk = evaluateBulk(names.length, this.deps.maxBulkItems, 'branches');
    if (bulk) return blockedWith(bulk);
    const states: BranchState[] = [];
    for (const name of names) {
      const b = await this.readBranch(repo, name);
      if (!b) throw new RollikeyError('branch_not_found', `Branch "${name}" does not exist in ${repo}`);
      states.push(b);
    }
    const prot = states.filter((b) => b.protected || this.deps.protectedBranches.includes(b.name));
    if (prot.length) return blockedWith(`Protected-branch gate: refusing to delete protected branch${prot.length > 1 ? 'es' : ''} ${prot.map((b) => `"${b.name}"`).join(', ')}`);
    const snap = await recordAction(this.deps.pool, { runId: req.runId, actionType: 'github.branch_delete', target: repo, status: 'pending', request: req, beforeState: { repo, branches: states }, rowsAffected: states.length, amountCents: 0 });
    const deleted: string[] = [];
    try {
      for (const b of states) {
        await this.api('DELETE', repo, `git/refs/heads/${encPath(b.name)}`);
        deleted.push(b.name);
      }
      await completeAction(this.deps.pool, snap.id, { repo, deleted });
      return { status: 'applied', runId: req.runId, seq: snap.seq, snapshotId: snap.id, repo, items: deleted.length, branches: deleted, amountCents: 0 };
    } catch (err) {
      await noteActionError(this.deps.pool, snap.id, (err as Error).message, { repo, deleted });
      throw err;
    }
  }

  // ---- inverse used by revert() ----------------------------------------------------------------
  async restore(snap: SnapshotRow): Promise<Record<string, unknown>> {
    if (snap.action_type === 'github.branch_delete') {
      const before = snap.before_state as { repo: string; branches: BranchState[] };
      const recreated: string[] = [];
      const alreadyPresent: string[] = [];
      for (const b of [...before.branches].reverse()) {
        const cur = await this.readBranch(before.repo, b.name);
        if (cur) {
          if (cur.sha !== b.sha) throw new RollikeyError('branch_drift', `Branch "${b.name}" exists again at ${cur.sha}, not the saved ${b.sha}; manual action required`);
          alreadyPresent.push(b.name);
          continue;
        }
        await this.createBranch(before.repo, b.name, b.sha);
        recreated.push(`${b.name}@${b.sha.slice(0, 7)}`);
      }
      return { type: 'branches_recreated', repo: before.repo, recreated, alreadyPresent };
    }
    const before = snap.before_state as { repo: string; kind: 'issue' | 'pull'; items: ItemState[] };
    const restored: number[] = [];
    for (const it of [...before.items].reverse()) {
      await this.api('PATCH', before.repo, `${before.kind === 'pull' ? 'pulls' : 'issues'}/${it.number}`, {
        title: it.title, body: it.body, state: it.state, labels: it.labels, ...(it.base ? { base: it.base } : {}),
      });
      restored.push(it.number);
    }
    return { type: before.kind === 'pull' ? 'pulls_restored' : 'issues_restored', repo: before.repo, restored };
  }
}
