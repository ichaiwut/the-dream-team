import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { featureFile, FILES } from "./paths.js";

/**
 * Committing the finished work, on the PO's approval at the last gate.
 *
 * Deliberately narrow. pmctl doesn't create or delete branches (that stays
 * the PO's manual step) and this doesn't push either — it commits what is
 * in the working tree, on whatever branch is already checked out, and
 * stops. A commit is recoverable locally; a push is a side effect on a
 * shared remote that nobody asked for.
 *
 * The commit runs through normal git, hooks included. If a pre-commit hook
 * rejects the work that's a real answer about the work, not an obstacle to
 * route around, so there is no --no-verify anywhere here.
 */

/**
 * pmctl's own machinery, never part of the feature's work:
 * `.pmctl/` is run state, and `.claude/settings.local.json` is the
 * machine-local permission file pmctl writes itself — local by name and by
 * convention, and not something to push into a shared repo on the PO's
 * behalf.
 */
const EXCLUDED_PREFIXES = [".pmctl/", ".claude/settings.local.json"];
const EXCLUDE_PATHSPECS = [":(exclude).pmctl", ":(exclude).claude/settings.local.json"];

function isExcluded(p: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
}

/**
 * Paths that were already dirty before the run started.
 *
 * Committing with `git add -A` would sweep up whatever the PO happened to
 * have lying around — editor scratch files, a local .env, build output, an
 * unrelated half-finished change — and record it under this feature's
 * commit message. A baseline taken at run start is what makes "the work"
 * separable from "everything else in the tree": anything already dirty
 * then is the PO's own business and is left exactly as it is, reported
 * rather than silently included.
 *
 * A file Dev edited that was *also* already dirty is excluded too, on the
 * same reasoning: committing it would carry the PO's earlier unrelated
 * edits along with Dev's, and splitting those is not pmctl's call to make.
 */
function baselineFile(repoRoot: string, feature: string): string {
  return featureFile(repoRoot, feature, "gitBaseline");
}

function statusPaths(repoRoot: string): string[] {
  const raw = git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
  return raw
    .split("\n")
    .filter(Boolean)
    // Porcelain v1: two status chars, a space, then the path. A rename
    // reads "old -> new"; the new name is what a commit would contain.
    .map((line) => line.slice(3).trim())
    .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1] : p))
    .map((p) => p.replace(/^"|"$/g, ""));
}

/** Records what was already dirty. Called once, when a run first starts. */
export function recordGitBaseline(repoRoot: string, feature: string, worktreePath: string): void {
  try {
    const file = baselineFile(repoRoot, feature);
    if (fs.existsSync(file)) return; // a resumed run keeps its original baseline
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(statusPaths(worktreePath), null, 2), "utf8");
  } catch {
    // Without a baseline the commit falls back to "nothing pre-existing",
    // which is the conservative direction only if the tree was clean — so
    // readBaseline treats a missing file as "unknown" and commits nothing
    // it can't attribute. See listPendingChanges.
  }
}

function readBaseline(repoRoot: string, feature: string): string[] | null {
  try {
    const file = baselineFile(repoRoot, feature);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as string[];
  } catch {
    return null;
  }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface PendingChanges {
  /** What a commit would contain: changed during this run, outside .pmctl. */
  files: string[];
  /** Already dirty before the run — deliberately left for the PO. */
  preExisting: string[];
}

/**
 * What a commit would include: everything changed or untracked except
 * pmctl's own `.pmctl/` directory. Returns empty when the tree is clean,
 * which is a normal outcome — a run can legitimately change nothing (a
 * review-only pass, or Dev concluding the code was already correct).
 */
export function listPendingChanges(worktreePath: string, repoRoot: string, feature: string): PendingChanges {
  try {
    const all = statusPaths(worktreePath).filter((p) => !isExcluded(p));
    const baseline = readBaseline(repoRoot, feature);
    if (baseline === null) {
      // No baseline recorded, so nothing here can be attributed to this
      // run. Committing everything would be the dangerous guess; committing
      // nothing just means the PO does it themselves.
      return { files: [], preExisting: all };
    }
    const before = new Set(baseline);
    return {
      files: all.filter((p) => !before.has(p)),
      preExisting: all.filter((p) => before.has(p)),
    };
  } catch {
    return { files: [], preExisting: [] };
  }
}

export interface CommitResult {
  ok: boolean;
  /** Short hash on success. */
  hash?: string;
  /** Why it failed — git's own stderr, which is what the PO needs to see. */
  error?: string;
  files: string[];
}

/**
 * The commit message PM was asked to write at the final stage, if it did.
 * PM has the context for a useful subject line; pmctl has none beyond the
 * feature name, so it asks rather than inventing one — and falls back to
 * something plain and honest when the file isn't there.
 */
export function readCommitMessage(repoRoot: string, feature: string, clickupRef: string): string {
  try {
    const file = featureFile(repoRoot, feature, "commitMessage");
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text) return text;
    }
  } catch {
    // fall through to the generic message
  }
  return `${feature}: งานเสร็จตาม ${clickupRef}`;
}

export function commitWork(
  worktreePath: string,
  repoRoot: string,
  feature: string,
  message: string
): CommitResult {
  const { files } = listPendingChanges(worktreePath, repoRoot, feature);
  if (files.length === 0) return { ok: false, error: "ไม่มีการเปลี่ยนแปลงจากรอบนี้ให้ commit", files: [] };
  try {
    // Named paths only — never `git add -A` across the tree. Anything the
    // run didn't touch stays out, whatever it is.
    git(worktreePath, ["add", "--", ...files, ...EXCLUDE_PATHSPECS]);
    const staged = git(worktreePath, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
    if (staged.length === 0) return { ok: false, error: "ไม่มีไฟล์ที่ stage ได้", files: [] };
    git(worktreePath, ["commit", "-m", message]);
    const hash = git(worktreePath, ["rev-parse", "--short", "HEAD"]).trim();
    return { ok: true, hash, files: staged };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = e.stderr ? e.stderr.toString() : "";
    const stdout = e.stdout ? e.stdout.toString() : "";
    return {
      ok: false,
      // Hook output usually lands on stdout, the git error on stderr; the
      // PO needs whichever one explains the rejection.
      error: `${stderr}${stdout}`.trim() || e.message || "commit ไม่สำเร็จ",
      files,
    };
  }
}

/** Absolute path of the repo the commit would land in. */
export function describeRepo(repoRoot: string): string {
  return path.resolve(repoRoot);
}
