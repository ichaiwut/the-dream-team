import fs from "node:fs";

/**
 * What one sub-agent session cost, pulled out of whatever `claude` wrote
 * into its tee'd log.
 *
 * PM runs Dev/Reviewer/Tester with `--output-format json`, which emits a
 * single result envelope when the session ends — so these numbers exist
 * only from the moment that agent finishes, not while it works. That's a
 * property of the output format, not an oversight: the alternative
 * (`stream-json`) would give live per-turn usage but turns the readable
 * transcript in the panel into a stream of events to reassemble, and the
 * panel is the thing the PO actually watches.
 */
export interface SessionStats {
  turns?: number;
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Everything the model had to read on the final turn. */
  contextTokens?: number;
  isError?: boolean;
}

/**
 * Context window to measure against. The envelope reports tokens used but
 * not the model's limit, so a percentage needs a number from somewhere —
 * this is the standard window for the Claude models the CLI runs by
 * default. It's shown as an approximation and nothing depends on it being
 * exact; a model with a different window makes the percentage wrong but
 * the token counts beside it still right.
 */
export const ASSUMED_CONTEXT_WINDOW = 200_000;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function mergeUsage(into: SessionStats, usage: Record<string, unknown> | undefined): void {
  if (!usage) return;
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheCreate = num(usage.cache_creation_input_tokens);
  if (input !== undefined) into.inputTokens = input;
  if (output !== undefined) into.outputTokens = output;
  if (cacheRead !== undefined) into.cacheReadTokens = cacheRead;
  if (cacheCreate !== undefined) into.cacheCreationTokens = cacheCreate;
  // Cached reads are still context the model processed, so they belong in
  // the total — leaving them out makes a long session look tiny, which is
  // the opposite of useful when the question is "is this about to run out
  // of room?".
  const parts = [into.inputTokens, into.cacheReadTokens, into.cacheCreationTokens].filter(
    (n): n is number => n !== undefined
  );
  if (parts.length > 0) into.contextTokens = parts.reduce((a, b) => a + b, 0);
}

/**
 * Reads stats out of a session log. Tolerates the two shapes the CLI can
 * produce (one final envelope, or a stream of events) and several
 * concatenated sessions in one file — an agent dispatched twice after an
 * iteration appends a second envelope, and the latest one is the one that
 * describes the session now on screen.
 */
export function parseSessionStats(raw: string): SessionStats | null {
  let found = false;
  const stats: SessionStats = {};
  for (const candidate of raw.split(/\n(?=\{)/)) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const turns = num(parsed.num_turns);
    const duration = num(parsed.duration_ms);
    const cost = num(parsed.total_cost_usd);
    if (turns !== undefined) (stats.turns = turns), (found = true);
    if (duration !== undefined) (stats.durationMs = duration), (found = true);
    if (cost !== undefined) (stats.costUsd = cost), (found = true);
    if (parsed.is_error === true || parsed.subtype === "error") stats.isError = true;
    const usage = (parsed.usage ?? (parsed.message as Record<string, unknown> | undefined)?.usage) as
      | Record<string, unknown>
      | undefined;
    if (usage) {
      mergeUsage(stats, usage);
      found = true;
    }
  }
  return found ? stats : null;
}

export function readSessionStats(file: string): SessionStats | null {
  try {
    if (!fs.existsSync(file)) return null;
    return parseSessionStats(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return sec % 60 === 0 ? `${min}m` : `${min}m${sec % 60}s`;
}

/** One line for a panel header: context first, since that's the one that
 *  decides whether the agent is still able to do good work. */
export function formatSessionStats(stats: SessionStats): string {
  const bits: string[] = [];
  if (stats.contextTokens !== undefined) {
    const pct = Math.round((stats.contextTokens / ASSUMED_CONTEXT_WINDOW) * 100);
    bits.push(`context ~${formatTokens(stats.contextTokens)} (~${pct}% ของ ${formatTokens(ASSUMED_CONTEXT_WINDOW)})`);
  }
  if (stats.outputTokens !== undefined) bits.push(`out ${formatTokens(stats.outputTokens)}`);
  if (stats.turns !== undefined) bits.push(`${stats.turns} turns`);
  if (stats.durationMs !== undefined) bits.push(formatDuration(stats.durationMs));
  if (stats.costUsd !== undefined) bits.push(`$${stats.costUsd.toFixed(2)}`);
  return bits.join(" · ");
}

/**
 * Rough token count for text pmctl composed itself (PM's prompt and system
 * prompt). PM runs in plain text mode and so reports no usage at all, but
 * its starting context is something pmctl built and can therefore measure —
 * it just has to divide by something, since tokenizing properly would mean
 * shipping a tokenizer for a number shown to one significant figure. Thai
 * runs appreciably more tokens per character than English, and these
 * prompts are a mix, so this lands within a factor that's fine for "is the
 * system prompt 4k or 40k" and is labelled as an estimate everywhere.
 */
export function estimateTokens(text: string): number {
  const thaiChars = (text.match(/[฀-๿]/g) ?? []).length;
  const otherChars = text.length - thaiChars;
  return Math.round(thaiChars / 1.6 + otherChars / 3.8);
}

export function formatEstimatedTokens(n: number): string {
  return formatTokens(n);
}
