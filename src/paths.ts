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
  // What the PO typed before the run started: scope limits, files not to
  // touch, approaches the client already rejected — the context that lives
  // in the PO's head rather than in the ClickUp ticket. Absent when they
  // had nothing to add, which is a normal thing to have nothing of.
  poBrief: "po-brief.md",
  // Messages the PO typed while the run was in progress. Append-only and
  // timestamped: PM reads the whole file at the start of every stage and
  // treats it as standing instructions, so a message is never "delivered"
  // once and lost. It cannot reach the invocation already running — that's
  // a headless `claude -p` with no stdin to interrupt — so the file is how
  // "I want to say something now" becomes "PM acts on it next stage".
  poMessages: "po-messages.md",
  // Commit message PM writes at the final stage. PM has the context for a
  // useful subject line; pmctl, which runs the commit, has none beyond the
  // feature name — so it asks rather than inventing one.
  commitMessage: "commit-message.txt",
  // Paths already dirty when the run started, so the final commit can tell
  // this run's work apart from whatever the PO had lying around.
  gitBaseline: "git-baseline.json",
  // The exact prompt PM sends each sub-agent, written by PM just before
  // dispatching. PM composes these inside its own bash call, so without a
  // file the PO only ever sees the agent's reply — half a conversation.
  devPrompt: "dev-prompt.md",
  reviewerPrompt: "reviewer-prompt.md",
  testerPrompt: "tester-prompt.md",
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
