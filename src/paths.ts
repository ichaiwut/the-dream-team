import path from "node:path";
import fs from "node:fs";

export function stateRoot(repoRoot: string): string {
  return path.join(repoRoot, ".pmctl");
}

export function featureDir(repoRoot: string, feature: string): string {
  return path.join(stateRoot(repoRoot), feature);
}

export function ensureFeatureDir(repoRoot: string, feature: string): string {
  const dir = featureDir(repoRoot, feature);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const FILES = {
  meta: "meta.json",
  spec: "spec.md",
  plan: "plan.md",
  review: "review.md",
  report: "report.md",
  log: "log.ndjson",
  pmSession: "pm-session.log",
};

export function featureFile(repoRoot: string, feature: string, file: keyof typeof FILES): string {
  return path.join(featureDir(repoRoot, feature), FILES[file]);
}
