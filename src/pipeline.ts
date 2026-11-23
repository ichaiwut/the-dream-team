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

export interface ChecklistItem {
  id: string;
  label: string;
  status: "done" | "current" | "pending";
}

export interface Checklist {
  items: ChecklistItem[];
  iterationCount: number;
  needsAttention: boolean;
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

  for (const entry of log) {
    if (entry.step === "iteration") {
      iterationCount++;
      pointer = Math.min(pointer, 2); // back to right after plan_awaiting_approval
      continue;
    }
    if (entry.step === "needs_po_attention") {
      needsAttention = true;
      continue;
    }
    const idx = PIPELINE.findIndex((p) => p.id === entry.step);
    if (idx !== -1 && idx > pointer) pointer = idx;
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
    status:
      i < pointer
        ? "done"
        : i === currentPointer
          ? (i === PIPELINE.length - 1 ? "done" : "current")
          : "pending",
  }));

  return { items, iterationCount, needsAttention };
}

export function checklistColor(status: ChecklistItem["status"]): string | undefined {
  if (status === "done") return "green";
  if (status === "current") return "yellow";
  return undefined;
}

export function checklistMark(status: ChecklistItem["status"]): string {
  if (status === "done") return "☑";
  if (status === "current") return "▶";
  return "☐";
}
