# pmctl

ตัวควบคุม PO → PM(agent) → Dev(agent) → Tester(agent) ที่รันบนเครื่องตัวเอง สร้างขึ้นมาจากแนวคิดของ [saaio](https://saaio.dev/) แต่ตัด TUI/multi-worker orchestration ออก เหลือแค่สายงานเดียวที่คุณ (PO) เป็นคนเริ่ม

## กติกาที่ออกแบบไว้ (จากการคุยกัน)

- **PO คุยกับ PM เท่านั้น** — ไม่คุยกับ Dev/Tester ตรงๆ
- **ClickUp เขียนได้แค่ PO** — PM อ่านอย่างเดียว (บังคับจริงด้วยการไม่ส่ง `CLICKUP_API_TOKEN` เข้าไปใน environment ของ PM/Dev/Tester เลย ไม่ใช่แค่บอกในคำสั่ง)
- **log การทำงานไม่เก็บใน ClickUp** — เก็บเป็นไฟล์ local แบบ append-only (`.pmctl/<feature>/log.ndjson`) ตามแนวทางของ saaio เอง
- **PM ต้องเขียนแผนงาน (`plan.md`) ก่อนสั่ง Dev ทุกครั้ง** — มีเป้าหมาย/แนวทาง/flow/รายการไฟล์ที่กระทบ
- **Tester ต้องรัน unit แล้วค่อย e2e จริง ไม่ใช่แค่อ่านโค้ด** — เขียนผลเป็น `report.md` แยกจาก `plan.md`
- Dev/Tester ไม่รู้จัก PO เลย เป็นแค่ subprocess ที่ PM เรียก

## ติดตั้ง

```bash
cd pmctl
npm install
npm run build
npm link   # ทำให้เรียก `pmctl` ได้จากทุกที่ (หรือจะรันผ่าน `node dist/cli.js` ตรงๆ ก็ได้)
```

ต้องมี [Claude Code](https://claude.com/claude-code) (`claude` CLI) ติดตั้งและ login ไว้แล้วในเครื่อง

## ⚠️ สิ่งที่ต้องเช็คเองก่อนใช้จริง

**flag ของ `claude` CLI ที่ใช้ใน `src/agents.ts` และ `roles/pm.md`** (`--append-system-prompt`, `--permission-mode`, `--output-format`) เขียนจากความเข้าใจทั่วไปของ Claude Code ตอนที่เขียนโค้ดนี้ — เวอร์ชันที่ลงในเครื่องคุณอาจมีชื่อ flag ต่างไปบ้าง ให้รัน:

```bash
claude --help
```

เทียบก่อนใช้งานจริงรอบแรก ถ้า flag ไม่ตรง ให้แก้ตรง `buildVars`/args ใน `src/agents.ts` ให้ตรงกับเวอร์ชันจริง (จุดเดียวที่ประกอบคำสั่งเรียก Dev/Tester คือใน `roles/pm.md` เพราะ PM เป็นคนเรียกเองผ่าน bash — ถ้า flag เปลี่ยน แก้ไฟล์นี้พอ ไม่ต้องแก้โค้ด TypeScript)

`--permission-mode acceptEdits` คือค่า default ที่ตั้งไว้ให้ทำงานไม่ต้องกด approve ทุก edit (เพราะรันแบบ unattended) — ถ้าอยากเข้มกว่านี้/หลวมกว่านี้ ปรับด้วย `--permission-mode` ตอนรัน `pmctl run`

## ใช้งาน

```bash
export CLICKUP_API_TOKEN=pk_xxxxx   # token ของ PO เท่านั้น ไม่แชร์ให้ PM

cd your-repo
pmctl run add-dark-mode --clickup 86abc123de
```

จะเกิดขึ้น:
1. สร้าง git worktree ใหม่ (`../your-repo-add-dark-mode`) + branch `feature/add-dark-mode` + จองพอร์ตอัตโนมัติ
2. ดึง ClickUp task มาเป็น `.pmctl/add-dark-mode/spec.md` (snapshot ครั้งเดียว)
3. เริ่ม PM session (`claude` subprocess ที่มี bash tool) ให้ทำตาม `roles/pm.md`: วางแผน → เขียน plan.md → สั่ง Dev → สั่ง Tester (รัน e2e จริง) → วนแก้ถ้า fail → เขียนสรุปจบ

ระหว่างทาง/หลังจบ เช็คได้ตลอดโดยไม่ต้องรบกวน PM:

```bash
pmctl status              # ดูทุก feature ที่กำลังทำ + log ล่าสุด
pmctl log add-dark-mode   # ไล่ดู log แบบเต็ม (ใครทำอะไร เหตุผลอะไร)
pmctl plan add-dark-mode  # อ่านแผนงานของ PM
pmctl report add-dark-mode # อ่านผลเทสของ Tester
```

ถ้า ClickUp task ถูกแก้ไขหลังเริ่มงานไปแล้ว:

```bash
pmctl refresh-spec add-dark-mode --clickup 86abc123de
```

เสร็จงาน merge แล้วเก็บกวาด:

```bash
pmctl clean add-dark-mode   # ลบ worktree (log/plan/report ใน .pmctl/ ยังอยู่ ไม่หาย)
```

## โครงสร้างไฟล์ที่เกิดขึ้นต่อ 1 feature

```
.pmctl/add-dark-mode/
  meta.json       # branch, worktree path, port, clickup task id
  spec.md         # snapshot จาก ClickUp (PM อ่านอย่างเดียว)
  plan.md         # เขียนโดย PM ก่อนสั่ง Dev
  report.md       # เขียนโดย Tester หลังรัน e2e
  log.ndjson      # append-only, ทุก milestone ของ PM/Dev/Tester
  pm-session.log  # raw transcript เต็มของ PM session (เผื่อ debug ลึก)
```

## ข้อจำกัดที่รู้อยู่แล้ว (บอกไว้ตรงๆ)

- "ClickUp อ่านอย่างเดียว" เป็นการบังคับระดับโค้ด (ไม่ส่ง token ให้ subprocess) ไม่ใช่ API scope ของ ClickUp เอง — ถ้าใครเอา token ไปรันเองนอกเครื่องมือนี้ก็เขียนได้ปกติ
- ยังไม่ได้ลองรันกับ `claude` CLI จริงในสภาพแวดล้อมนี้ (sandbox นี้ไม่มี `claude` ติดตั้ง) — โค้ดส่วน worktree/port/clickup/log ทดสอบแล้วทำงานได้จริง ส่วน PM/Dev/Tester loop ทดสอบได้แค่ logic การประกอบคำสั่ง ยังไม่ได้ end-to-end กับ claude CLI จริง — ลองรอบแรกแล้วดูว่า flag/behavior ตรงไหนต้องปรับ
- ยังไม่มีการจำกัดว่า Dev agent จะรันคำสั่งอันตรายในเครื่องได้ (`--permission-mode acceptEdits` ยอมรับการแก้ไฟล์อัตโนมัติ) — ถ้าเป็นงานที่กระทบข้อมูลสำคัญ ควรปรับเป็นโหมดที่เข้มกว่านี้หรือรีวิวเองก่อน merge จริง
