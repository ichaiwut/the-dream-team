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

export function createWorktree(repoRoot: string, feature: string, clickupTaskId?: string): Meta {
  const repoName = path.basename(repoRoot);
  const worktreePath = path.join(path.dirname(repoRoot), `${repoName}-${feature}`);
  const branch = `feature/${feature}`;
  const port = nextFreePort(repoRoot);

  execFileSync("git", ["worktree", "add", worktreePath, "-b", branch], {
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
