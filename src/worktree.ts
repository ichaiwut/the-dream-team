import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureFeatureDir, featureFile, stateRoot } from "./paths.js";

export interface Meta {
  feature: string;
  branch: string;
  worktreePath: string;
  port: number;
  clickupTaskId?: string;
  createdAt: string;
}

const BASE_PORT = 3001;

function usedPorts(repoRoot: string): Set<number> {
  const root = stateRoot(repoRoot);
  const ports = new Set<number>();
  if (!fs.existsSync(root)) return ports;
  for (const name of fs.readdirSync(root)) {
    const metaPath = path.join(root, name, "meta.json");
    if (fs.existsSync(metaPath)) {
      try {
        const meta: Meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        ports.add(meta.port);
      } catch {
        /* ignore malformed meta */
      }
    }
  }
  return ports;
}

export function nextFreePort(repoRoot: string): number {
  const used = usedPorts(repoRoot);
  let port = BASE_PORT;
  while (used.has(port)) port++;
  return port;
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function createWorktree(
  repoRoot: string,
  feature: string,
  clickupTaskId?: string,
  branchOverride?: string,
): Meta {
  const repoName = path.basename(repoRoot);
  const worktreePath = path.join(path.dirname(repoRoot), `${repoName}-${feature}`);
  const branch = branchOverride ?? `feature/${feature}`;
  const port = nextFreePort(repoRoot);

  const metaPath = featureFile(repoRoot, feature, "meta");
  if (fs.existsSync(metaPath)) {
    throw new Error(
      `feature "${feature}" มีอยู่แล้ว (เจอ ${metaPath}) — ถ้าทำเสร็จ/เลิกใช้แล้วให้ "pmctl clean ${feature}" ก่อน ` +
        `หรือถ้าจะเริ่มงานใหม่ให้ใช้ชื่อ feature อื่น`,
    );
  }

  // pmctl does not create or delete branches itself — that's the PO's call.
  // The branch must already exist (created by hand, e.g. `git branch ${branch}`
  // or `git checkout -b ${branch}`) before `pmctl run` is used.
  if (!branchExists(repoRoot, branch)) {
    throw new Error(
      `ไม่พบ branch "${branch}" — pmctl ไม่สร้าง branch ให้เองแล้ว กรุณาสร้างเองก่อน เช่น "git branch ${branch}" ` +
        `(หรือถ้าอยากใช้ branch ชื่ออื่น ใช้ --branch <ชื่อ> ตอนรัน pmctl run)`,
    );
  }

  if (fs.existsSync(worktreePath)) {
    // A leftover worktree directory from a previous incomplete run. This is
    // pmctl's own working-copy folder, not the user's branch, so it's safe to
    // clean up automatically — unlike the branch itself. Try to let git clean
    // it up properly first (in case it's still registered), then fall back to
    // a plain filesystem removal.
    try {
      execFileSync("git", ["worktree", "remove", worktreePath, "--force"], {
        cwd: repoRoot,
        stdio: "inherit",
      });
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  execFileSync("git", ["worktree", "add", worktreePath, branch], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  fs.writeFileSync(path.join(worktreePath, ".env.local"), `PORT=${port}\n`);

  ensureFeatureDir(repoRoot, feature);
  const meta: Meta = {
    feature,
    branch,
    worktreePath,
    port,
    clickupTaskId,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(featureFile(repoRoot, feature, "meta"), JSON.stringify(meta, null, 2));
  return meta;
}

export function loadMeta(repoRoot: string, feature: string): Meta {
  const metaPath = featureFile(repoRoot, feature, "meta");
  if (!fs.existsSync(metaPath)) {
    throw new Error(`ไม่พบ feature "${feature}" — ยังไม่ได้ pmctl run มาก่อนหรือเปล่า`);
  }
  return JSON.parse(fs.readFileSync(metaPath, "utf8"));
}

export function removeWorktree(repoRoot: string, feature: string): void {
  const meta = loadMeta(repoRoot, feature);
  execFileSync("git", ["worktree", "remove", meta.worktreePath, "--force"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}
