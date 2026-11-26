export interface GateLimits {
  maxRows: number;
  maxAmountCents: number;
}

export interface GateInput {
  rowsAffected: number;
  amountCents: number;
}

export type GateDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Blast-radius gate: a single call may touch at most `maxRows` rows and move at
 * most `maxAmountCents`. Anything strictly above either limit is blocked before
 * it executes.
 */
export function evaluateGate(input: GateInput, limits: GateLimits): GateDecision {
  const reasons: string[] = [];
  if (input.rowsAffected > limits.maxRows) {
    reasons.push(`affects ${input.rowsAffected} rows (limit ${limits.maxRows} per call)`);
  }
  if (input.amountCents > limits.maxAmountCents) {
    reasons.push(`moves ${formatCents(input.amountCents)} (limit ${formatCents(limits.maxAmountCents)} per call)`);
  }
  return reasons.length === 0 ? { allowed: true } : { allowed: false, reason: `Blast-radius gate: ${reasons.join('; ')}` };
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
