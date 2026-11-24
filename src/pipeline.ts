import { LogEntry } from "./log.js";

// The canonical PO->PM->Dev->Tester pipeline, in order, as roles/pm.md
// instructs PM to log it (log.ts' step field). Used both to render the TUI's
// todo-style checklist and to draw the flow chart in plan.html — kept in one
// place so the two views can never silently drift apart.
export const PIPELINE: { id: string; label: string }[] = [
  { id: "spec_fetched", label: "ดึง spec จาก ClickUp" },
  { id: "plan_written", label: "วางแผน (plan.md)" },
  { id: "plan_awaiting_approval", label: "รอ PO อนุมัติ plan" },
  { id: "dev_started", label: "สั่ง Dev" },
  { id: "dev_done", label: "Dev ทำงานเสร็จ" },
  { id: "reviewer_started", label: "สั่ง Reviewer ตรวจโค้ด" },
  { id: "reviewer_done", label: "Reviewer ผ่านแล้ว" },
  { id: "tester_started", label: "สั่ง Tester (e2e)" },
  { id: "tester_done", label: "Tester ตรวจสอบเสร็จ" },
  { id: "final_done", label: "จบงาน" },
];

/**
 * Every point where the chain hands work from one agent to the next, and
 * therefore every point the PO gets asked. The pipeline used to have
 * exactly one of these (the plan) and then ran Dev -> Reviewer -> Tester
 * -> done in a single uninterrupted PM invocation: the PO approved a plan
 * and the next thing they saw was a finished run, with no say in whether
 * the code was worth reviewing, whether the review was worth testing, or
 * whether a failure was worth another iteration.
 *
 * `afterStep` is the log step that opens the gate, `nextPhase` the PM
 * invocation approving it starts, and `artifact`/`source` which file the
 * PO reads while deciding. `iteration` is the odd one out: it's a failure
 * gate, so approving it sends work back to Dev rather than onward.
 */
export interface Gate {
  afterStep: string;
  nextPhase: "dev" | "reviewer" | "tester" | "final";
  title: string;
  question: string;
  /** FILES key of the markdown the PO reads at this gate. */
  source: "plan" | "devSummary" | "review" | "report";
  /** FILES key of the HTML artifact built from it. */
  artifact: "planHtml" | "devHtml" | "reviewHtml" | "testHtml";
}

export const GATES: Gate[] = [
  {
    afterStep: "plan_awaiting_approval",
    nextPhase: "dev",
    title: "plan.md รออนุมัติ",
    question: "อนุมัติ plan นี้ แล้วให้ PM สั่ง Dev ต่อเลยไหม",
    source: "plan",
    artifact: "planHtml",
  },
  {
    afterStep: "dev_done",
    nextPhase: "reviewer",
    title: "Dev ทำงานเสร็จ — รออนุมัติก่อนส่ง Reviewer",
    question: "ยอมรับงานของ Dev แล้วให้ส่งต่อ Reviewer ตรวจโค้ดไหม",
    source: "devSummary",
    artifact: "devHtml",
  },
  {
    afterStep: "reviewer_done",
    nextPhase: "tester",
    title: "Reviewer ตรวจผ่านแล้ว — รออนุมัติก่อนส่ง Tester",
    question: "ยอมรับผลตรวจโค้ด แล้วให้ส่งต่อ Tester รัน e2e ไหม",
    source: "review",
    artifact: "reviewHtml",
  },
  {
    afterStep: "tester_done",
    nextPhase: "final",
    title: "Tester ตรวจสอบเสร็จ — รออนุมัติก่อนปิดงาน",
    question: "ยอมรับผลเทสต์ แล้วให้ PM สรุปปิดงานไหม",
    source: "report",
    artifact: "testHtml",
  },
  {
    // Reviewer or Tester reported a failure. PM is told to stop here rather
    // than loop back on its own, so the PO decides whether another round of
    // Dev is actually the right answer — it often isn't (the spec was
    // wrong, the test was wrong, the whole approach needs rethinking).
    afterStep: "iteration",
    nextPhase: "dev",
    title: "ไม่ผ่าน — รอ PO ตัดสินใจว่าจะวนกลับไปแก้ไหม",
    question: "ให้วนกลับไปสั่ง Dev แก้ตามที่รายงานไว้ไหม",
    source: "review",
    artifact: "reviewHtml",
  },
];

export function gateFor(step: string): Gate | undefined {
  return GATES.find((g) => g.afterStep === step);
}

/**
 * Which stage a re-run should pick up at, from the log alone. Used when
 * `pmctl run` is pointed at a feature that already has state on disk: a
 * stage that was interrupted mid-flight (`*_started` with no matching
 * `*_done`) is simply redone, since a killed PM invocation leaves no
 * partial progress worth preserving — only its sub-agent may have, and
 * that shows up as files on disk the next attempt can see.
 */
export function phaseAfterLog(log: LogEntry[]): "dev" | "reviewer" | "tester" | "final" | "done" {
  for (let i = log.length - 1; i >= 0; i--) {
    const step = log[i].step;
    if (step === "final_done") return "done";
    if (step === "tester_started" || step === "tester_done" || step === "tester_skipped") {
      return step === "tester_started" ? "tester" : "final";
    }
    if (step === "reviewer_started" || step === "reviewer_done" || step === "reviewer_skipped") {
      return step === "reviewer_started" ? "reviewer" : "tester";
    }
    if (step === "dev_started" || step === "dev_done") return step === "dev_done" ? "reviewer" : "dev";
    if (step === "iteration") return "dev";
  }
  return "dev";
}

/**
 * A stage the PO told PM to skip for this feature (in the brief or a
 * message — never PM's own decision; see roles/pm.md). It advances the
 * pipeline like a completed stage but opens no gate: the PO already made
 * the call, so asking them to approve skipping the thing they asked to
 * skip is just a keystroke tax.
 */
export const SKIP_STEPS: Record<string, "reviewer" | "tester"> = {
  reviewer_skipped: "reviewer",
  tester_skipped: "tester",
};

export function isSkipStep(step: string): boolean {
  return step in SKIP_STEPS;
}

/**
 * The newest log entry that sits at a gate, if the run is currently parked
 * at one. Looks at the last pipeline-relevant entry rather than "does this
 * step appear anywhere", so a completed stage from an earlier iteration
 * doesn't re-open its gate.
 */
export function openGate(log: LogEntry[]): { gate: Gate; at: LogEntry; index: number } | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.step === "final_done") return null;
    const gate = gateFor(entry.step);
    if (gate) {
      // An iteration can come from either reviewer or tester, and the PO
      // needs to read whichever one actually failed. Walk back to the
      // stage that was in flight when it happened.
      if (gate.afterStep === "iteration") {
        for (let j = i - 1; j >= 0; j--) {
          if (log[j].step === "tester_started") {
            return { gate: { ...gate, source: "report", artifact: "testHtml" }, at: entry, index: i };
          }
          if (log[j].step === "reviewer_started") return { gate, at: entry, index: i };
        }
      }
      return { gate, at: entry, index: i };
    }
    // A *_started step means that stage is in flight, not parked.
    if (entry.step.endsWith("_started")) return null;
  }
  return null;
}

/** Index of the first `final_done`, or -1. Callers compare it against a
 *  watermark for the same reason gates do — see openGate's callers. */
export function finalDoneIndex(log: LogEntry[]): number {
  return log.findIndex((e) => e.step === "final_done");
}

export interface ChecklistItem {
  id: string;
  label: string;
  status: "done" | "current" | "pending" | "skipped";
}

export interface Checklist {
  items: ChecklistItem[];
  iterationCount: number;
  needsAttention: boolean;
  /**
   * When the step that's currently "current" was entered (ISO timestamp from
   * the log), and when the run's very first log line landed. Both are used
   * to answer the one question a static checklist can't: "is this stuck, or
   * just slow?" — a step sitting at 12m reads very differently from one at
   * 3s, and without a number on screen there's no way to tell them apart.
   * Null before anything has been logged at all.
   */
  currentSince: string | null;
  startedAt: string | null;
  /**
   * The newest log entry's own words (roles/pm.md has every agent write a
   * `reason` on each milestone). Shown as a live activity line so the panel
   * says what's happening right now, not just which box is ticked.
   */
  latest: LogEntry | null;
}

/**
 * Compact age, saaio-style: "4s", "12m", "1h3m". Deliberately short — it
 * sits at the end of a line that's already carrying a label.
 */
export function formatAge(fromIso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - new Date(fromIso).getTime());
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins === 0 ? `${hours}h` : `${hours}h${mins}m`;
}

/**
 * Turns the append-only log into a todo-style checklist against the fixed
 * pipeline above. Since Dev/Tester can be looped back into on a test
 * failure ("iteration" in roles/pm.md's step 4), the pointer rolls back to
 * just after the plan was approved on every iteration, so mid-loop the
 * checklist correctly shows Dev/Tester as pending again rather than staying
 * "done" from an earlier failed round.
 */
export function computeChecklist(log: LogEntry[]): Checklist {
  let pointer = -1;
  let iterationCount = 0;
  let needsAttention = false;
  // Timestamp of the log line that last moved the pointer forward (or rolled
  // it back on an iteration) — i.e. when the step now showing as "current"
  // actually began, not when the run as a whole started.
  let currentSince: string | null = null;
  // Which pipeline positions were satisfied by a skip rather than by work.
  const skipped = new Set<string>();

  for (const entry of log) {
    if (entry.step === "iteration") {
      iterationCount++;
      pointer = Math.min(pointer, 2); // back to right after plan_awaiting_approval
      currentSince = entry.ts;
      continue;
    }
    if (entry.step === "needs_po_attention") {
      needsAttention = true;
      continue;
    }
    // A skipped stage satisfies its own "*_done" position in the pipeline.
    const effectiveStep = isSkipStep(entry.step)
      ? `${SKIP_STEPS[entry.step]}_done`
      : entry.step;
    const idx = PIPELINE.findIndex((p) => p.id === effectiveStep);
    if (idx !== -1 && idx > pointer) {
      pointer = idx;
      currentSince = entry.ts;
      if (isSkipStep(entry.step)) {
        // Both rows for that stage: the dispatch never happened either, and
        // a ticked "สั่ง Tester" above a skipped "Tester ตรวจสอบเสร็จ"
        // claims a step that didn't occur.
        skipped.add(effectiveStep);
        skipped.add(`${SKIP_STEPS[entry.step]}_started`);
      }
    }
  }

  // Before PM has appended its very first log line, pointer stays -1 — but
  // PM is already alive and working toward step 0 (fetching the ClickUp
  // spec), possibly for a while (a slow ClickUp call, or just a lot of
  // reasoning). Without this, every item shows pending with no "current"
  // marker at all, which reads as "nothing is happening" even while PM's
  // own panel is visibly streaming output. Treating -1 like 0 here (for the
  // *current* marker only — not for "done") fixes that without claiming
  // step 0 is finished before it's logged as such.
  const currentPointer = Math.max(pointer, 0);
  const items: ChecklistItem[] = PIPELINE.map((p, i) => ({
    ...p,
    // A skipped stage reads as "ข้าม (PO สั่ง)" rather than a tick: it
    // advanced the pipeline, but nothing was checked, and a checklist that
    // can't tell those apart is worse than no checklist.
    label: skipped.has(p.id) ? `${p.label} — ข้าม (PO สั่ง)` : p.label,
    status: skipped.has(p.id)
      ? "skipped"
      : i < pointer
        ? "done"
        : i === currentPointer
          ? (i === PIPELINE.length - 1 ? "done" : "current")
          : "pending",
  }));

  return {
    items,
    iterationCount,
    needsAttention,
    currentSince,
    startedAt: log.length > 0 ? log[0].ts : null,
    latest: log.length > 0 ? log[log.length - 1] : null,
  };
}

export function checklistColor(status: ChecklistItem["status"]): string | undefined {
  if (status === "done") return "green";
  if (status === "current") return "yellow";
  // Not green: nothing was verified here, and it shouldn't read as if it was.
  if (status === "skipped") return "gray";
  return undefined;
}

export function checklistMark(status: ChecklistItem["status"]): string {
  if (status === "done") return "☑";
  if (status === "current") return "▶";
  if (status === "skipped") return "⊘";
  return "☐";
}
