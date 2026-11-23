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
  // Dev's own structured hand-off: what it changed, what it assumed, what
  // it couldn't decide. Dev used to report this only as the last message of
  // its session — buried inside the tee'd JSON envelope, readable by nobody
  // and openable as nothing. Reviewer and Tester each had a file; Dev, the
  // one whose work the whole rest of the chain is about, didn't.
  devSummary: "dev-summary.md",
  review: "review.md",
  report: "report.md",
  log: "log.ndjson",
  // PO's free-text answers to any "คำถามถึง PO" section PM wrote into
  // plan.md, typed in the terminal approval screen (see src/runView.tsx's
  // "a" key) before approving. Empty/absent when PM asked nothing or the PO
  // chose not to answer before approving anyway.
  answers: "answers.md",
  pmSession: "pm-session.log",
  devSession: "dev-session.log",
  reviewerSession: "reviewer-session.log",
  testerSession: "tester-session.log",
  // One readable artifact per gate, plus the end-of-run report. Written
  // next to their markdown sources and opened in the PO's browser at the
  // moment the stage finishes, so "what did Dev actually do" has an answer
  // that isn't "scroll back through a terminal pane".
  planHtml: "plan.html",
  devHtml: "dev.html",
  reviewHtml: "review.html",
  testHtml: "test.html",
  finalHtml: "report.html",
};

export function featureFile(repoRoot: string, feature: string, file: keyof typeof FILES): string {
  return path.join(featureDir(repoRoot, feature), FILES[file]);
}
