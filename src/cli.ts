#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import { createIsolatedWorktree, loadMeta, removeWorktree, useCurrentCheckout } from "./worktree.js";
import { appendLog, formatLog, readLog } from "./log.js";
import { featureFile, stateRoot } from "./paths.js";
import { spawnPmSession, spawnRefreshSpec } from "./agents.js";
import { watchFeatures } from "./watch.js";
import { runTui } from "./tui.js";
import { runPmSessionWithTui } from "./runView.js";

function isRealTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

const repoRoot = process.cwd();
const program = new Command();

program
  .name("pmctl")
  .description(
    "Local PO -> PM agent -> Dev agent -> Reviewer agent -> Tester agent orchestrator, built on the claude CLI (Claude Code)."
  );

program
  .command("run <feature>")
  .description(
    "เริ่ม PM session สำหรับ feature นี้ (ค่าเริ่มต้นทำงานตรงใน branch ปัจจุบันของคุณ ไม่สร้าง branch/worktree ใหม่)",
  )
  .requiredOption("--clickup <ref>", "ClickUp task id หรือวาง URL เต็มก็ได้ (เช่น https://app.clickup.com/t/9018044177/DSAG-218)")
  .option(
    "--isolate",
    "สร้าง git worktree แยกต่างหากแทนการทำงานในที่เดิม (ต้องมี branch ที่ตั้งใจใช้อยู่แล้ว pmctl จะไม่สร้างให้)",
  )
  .option(
    "--branch <name>",
    "ใช้กับ --isolate เท่านั้น: ชื่อ branch ที่สร้างไว้ล่วงหน้าแล้ว ค่าเริ่มต้นคือ feature/<feature>",
  )
  .option(
    "--permission-mode <mode>",
    "permission mode ที่ส่งให้ PM session (และ Dev/Reviewer/Tester ที่ PM สั่งต่อ ดูหัวข้อ permission mode ใน " +
      "README) ค่าเริ่มต้นคือ acceptEdits (auto-accept แค่ Edit/Write) — ถ้า Dev/Reviewer/Tester รันคำสั่ง bash ที่ไม่มี " +
      "allow rule ไว้ล่วงหน้า จะไปค้างรอ approval ที่ไม่มีใครตอบได้ (รันแบบ headless -p ทั้งสาย ไม่มี TTY) เนื่องจาก " +
      "pmctl run มี gate ให้ PO กด y/n อนุมัติ plan เป็นมนุษย์อยู่แล้วก่อนจะถึงขั้นสั่ง Dev ทุกครั้ง ถ้าไม่ต้องการให้ค้างแบบนี้อีก " +
      "ให้สั่งรันด้วย --permission-mode bypassPermissions เอง (ข้ามการขออนุมัติระดับ tool-call ทั้งหมดหลังจากจุดนั้น ไม่ใช่ " +
      "ค่า default ของ pmctl เอง เป็นการตัดสินใจที่ผู้ใช้ต้องเลือกเอง)",
    "acceptEdits",
  )
  .action(
    async (
      feature: string,
      opts: { clickup: string; isolate?: boolean; branch?: string; permissionMode: string },
    ) => {
      let meta;
      if (opts.isolate) {
        console.log(`[pmctl] สร้าง worktree แยกสำหรับ feature "${feature}"...`);
        meta = createIsolatedWorktree(repoRoot, feature, opts.clickup, opts.branch);
      } else {
        console.log(`[pmctl] เริ่ม feature "${feature}" ใน branch ปัจจุบัน (ไม่สร้าง worktree ใหม่)...`);
        meta = useCurrentCheckout(repoRoot, feature, opts.clickup);
      }

      appendLog(repoRoot, feature, {
        actor: "system",
        step: "feature_created",
        reason: `pmctl run เริ่มงานใหม่จาก ClickUp task ${opts.clickup}`,
        result: `worktree=${meta.worktreePath} port=${meta.port}`,
      });

      // Single-screen mode: when stdin/stdout are a real terminal, show PM's
      // live output next to a status panel in one Ink UI instead of making
      // you open a second terminal for `pmctl watch`. Falls back to plain
      // stdout streaming when there's no real TTY (piped output, CI, etc.),
      // same reasoning as the `watch` command's own fallback.
      const exitCode = isRealTty()
        ? await runPmSessionWithTui(repoRoot, meta, opts.permissionMode, opts.clickup)
        : await spawnPmSession(repoRoot, meta, opts.permissionMode, opts.clickup);

      if (exitCode !== 0) process.exitCode = exitCode;
    },
  );

program
  .command("refresh-spec <feature>")
  .description("สั่งให้ PM ดึง ClickUp task ใหม่อีกรอบทับ spec.md เผื่อ PO แก้ไข task ไปแล้วหลังเริ่มงาน")
  .requiredOption("--clickup <ref>")
  .action(async (feature: string, opts: { clickup: string }) => {
    const meta = loadMeta(repoRoot, feature);
    appendLog(repoRoot, feature, {
      actor: "system",
      step: "spec_refresh_requested",
      reason: "PO ขอดึง ClickUp task ใหม่ระหว่างทำงาน",
    });
    await spawnRefreshSpec(repoRoot, meta, opts.clickup);
    console.log(`[pmctl] อัปเดต spec.md แล้ว`);
  });

program
  .command("status")
  .description("แสดงรายการ feature ทั้งหมดที่กำลังทำอยู่")
  .action(() => {
    const root = stateRoot(repoRoot);
    if (!fs.existsSync(root)) {
      console.log("ยังไม่มี feature ไหนเริ่มทำงานเลย");
      return;
    }
    for (const feature of fs.readdirSync(root)) {
      try {
        const meta = loadMeta(repoRoot, feature);
        const log = readLog(repoRoot, feature);
        const last = log[log.length - 1];
        console.log(
          `- ${feature} (branch ${meta.branch}, port ${meta.port})` +
            (last ? `\n    ล่าสุด: [${last.actor}] ${last.step}` : "")
        );
      } catch {
        /* skip malformed feature dirs */
      }
    }
  });

program
  .command("log <feature>")
  .description("ไล่ดู log การทำงานทั้งหมดของ feature นี้ (append-only, ไม่อยู่ใน ClickUp)")
  .action((feature: string) => {
    console.log(formatLog(readLog(repoRoot, feature)));
  });

program
  .command("plan <feature>")
  .description("เปิดอ่านแผนงาน (plan.md) ของ feature นี้")
  .action((feature: string) => {
    const file = featureFile(repoRoot, feature, "plan");
    console.log(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(PM ยังไม่เขียนแผนงาน)");
  });

program
  .command("review <feature>")
  .description("เปิดอ่านผลตรวจโค้ด (review.md) ของ feature นี้")
  .action((feature: string) => {
    const file = featureFile(repoRoot, feature, "review");
    console.log(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(Reviewer ยังไม่เขียนผลตรวจ)");
  });

program
  .command("report <feature>")
  .description("เปิดอ่านผลเทส (report.md) ของ feature นี้")
  .action((feature: string) => {
    const file = featureFile(repoRoot, feature, "report");
    console.log(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(Tester ยังไม่เขียนผลเทส)");
  });

program
  .command("watch")
  .description(
    "เปิด TUI แบบ interactive ดูทุก feature พร้อมกัน (pmctl run เองก็โชว์ live view ของ feature ที่กำลังรันอยู่แล้ว — ใช้ watch ตอนอยากดูภาพรวมทุก feature จากที่เดียว หรือดูจากเครื่อง/terminal อื่น)",
  )
  .option("--interval <ms>", "ความถี่ในการ refresh สำหรับโหมด non-interactive (ms)", "1500")
  .option("--plain", "บังคับใช้โหมด non-interactive (plain polling) แม้มี TTY ก็ตาม")
  .action((opts: { interval: string; plain?: boolean }) => {
    const isInteractive = isRealTty() && !opts.plain;
    if (isInteractive) {
      runTui(repoRoot);
    } else {
      // ไม่มี TTY จริง (เช่นรันผ่าน pipe/CI) — ใช้โหมด plain เพราะ Ink
      // ต้องการ raw-mode stdin ซึ่งใช้ไม่ได้ในสภาพแวดล้อมแบบนั้น
      watchFeatures(repoRoot, Number(opts.interval));
    }
  });

program
  .command("clean <feature>")
  .description("ลบ worktree ของ feature นี้ทิ้ง (ทำหลังจาก merge/ปิดงานแล้ว)")
  .action((feature: string) => {
    removeWorktree(repoRoot, feature);
    console.log(`[pmctl] ลบ worktree ของ "${feature}" แล้ว (ไฟล์ log/plan/report ใน .pmctl/ ยังอยู่)`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[pmctl] error: ${msg}`);
  process.exitCode = 1;
});
