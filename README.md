# pmctl

A local CLI orchestrator for a strict PO → PM → Dev → Reviewer → Tester agent chain, built on top of [Claude Code](https://claude.com/claude-code). Inspired by [saaio](https://saaio.dev/)'s worktree-per-flow model, scoped down to a single accountable chain instead of a multi-worker TUI.

## Why

Giving one agent full autonomy over a feature — writing the code, testing it, and deciding it's done — means the same model grades its own work. `pmctl` splits that into separate roles with a hard communication boundary, and gives the human (PO) a durable, auditable trail without needing to sit in on every exchange:

- **PO** (you) — owns the spec in ClickUp and signs off on acceptance testing. Never talks to Dev, Reviewer or Tester directly.
- **PM** (agent) — reads the spec, writes a plan before any code is touched, dispatches Dev, Reviewer and Tester in that order, and is the only role that talks to any of them.
- **Dev** (agent) — implements against PM's instructions in the working copy PM dispatched it to (your current checkout by default, or an isolated git worktree with `--isolate`). Has no path to reach the PO.
- **Reviewer** (agent) — reviews Dev's code for security issues, bad patterns, and drift from the plan, *before* Tester ever runs — not by running anything, just reading the diff. Can't edit files itself (`--disallowedTools "Edit,Write"`); a blocker sends PM back to Dev, same as a failed test would.
- **Tester** (agent) — independently verifies Dev's (reviewed) work by actually running tests (unit, then real e2e), not by reading the diff and approving it.

## Design rules this tool enforces

| Rule | How it's enforced |
|---|---|
| ClickUp is write-only for the PO; everyone else only reads it (PM) or doesn't touch it at all (Dev/Reviewer/Tester) | PM uses your own already-authenticated ClickUp MCP connector to read a task, but is spawned with `--disallowedTools` naming every write-capable ClickUp tool (`src/clickupTools.ts`) — Claude Code's own permission system refuses the call if PM tries one. `roles/pm.md` passes the exact same `--disallowedTools` list when it spawns Dev, Reviewer and Tester, so none of them can write to ClickUp either, not just PM. This is a blocklist, not a withheld credential; see "Known limitations" |
| The working log is never stored in ClickUp | Every milestone is appended to a local, append-only `.pmctl/<feature>/log.ndjson` — plain files the PO can read any time without waiting on a summary |
| PM must plan before dispatching Dev | `roles/pm.md` requires `plan.md` (goal, approach, flow, affected files) to exist before Dev is invoked, for every feature regardless of size |
| Code gets reviewed before it gets tested | `roles/pm.md` forbids dispatching Tester until Reviewer has written a PASS verdict to `review.md`; a FAIL sends Dev back to fix it, same loop a failed test uses |
| Reviewer can't fix what it flags | Reviewer is spawned with `--disallowedTools "Edit,Write"` — it can point out a problem but can't patch around it itself, keeping the "who wrote it" / "who checked it" separation real |
| Tester must prove it, not assert it | `roles/tester.md` forbids a pass verdict based on reading code; it must run the unit suite, then execute real e2e scenarios against a running instance, and cite command output as evidence in `report.md` |
| Plan, review and test report are separate artifacts | `plan.md` is owned by PM, `review.md` is owned by Reviewer, `report.md` is owned by Tester — each one documents one side of the work |

## Requirements

- Node.js >= 18
- [Claude Code](https://claude.com/claude-code) (`claude` CLI) installed and authenticated
- A ClickUp MCP connector already configured for your Claude Code account (the same one you use day to day) — PM reads through it, no separate API token needed
- A git repository to run features against (this repo, `pmctl` itself, is just where the tool's source lives — you run it *inside* the project you're building)

## Install

```bash
git clone git@github.com:ichaiwut/the-dream-team.git
cd the-dream-team
npm install
npm run build
npm link        # exposes `pmctl` globally; or invoke node dist/cli.js directly without linking
```

## Before first real use

The `claude` CLI flags this tool shells out to (`--append-system-prompt`, `--permission-mode`, `--disallowedTools`) were written against a general understanding of Claude Code's interface at the time this was built. Flag names can change between versions. Before running this against real work:

```bash
claude --help
```

and compare against what's used in `src/agents.ts` and `roles/pm.md`. If something's changed, `roles/pm.md` is the only file to edit — PM constructs its own calls to Dev, Reviewer and Tester from that template via its bash tool, so a flag change doesn't require touching any TypeScript.

`--permission-mode acceptEdits` is the default — passed to PM's own session *and* propagated to the Dev/Reviewer/Tester invocations PM spawns (`roles/pm.md`'s `{{SUB_AGENT_PERMISSION_MODE}}`, filled in from whichever mode you pass here, so it's consistent across all four roles instead of hardcoded separately for each). `acceptEdits` only auto-approves Edit/Write tool calls — a Bash command with no matching allow rule in `.claude/settings.local.json` still hits an interactive approval prompt, and since every one of PM/Dev/Reviewer/Tester's invocations is a fully headless `claude -p` call with no TTY attached, nothing can ever answer that prompt: `pmctl run` just hangs indefinitely at that exact command (a real run hit this on a plain `cp *.png ...`, not anything unusual).

The plan-approval gate (above) already puts a human checkpoint — the PO pressing `y`/`n` — in front of every `pmctl run` before Dev is ever dispatched, so a second, tool-call-level approval wall on top of that mostly just produces unanswerable hangs rather than added safety. If you'd rather not hit that hang, run with `--permission-mode bypassPermissions` yourself: it removes the interactive-approval step for every tool call (Bash included) across all four roles for that run. This is **not** the default — pmctl doesn't choose this for you — because it's a real security trade-off (see Known Limitations) that's yours to make per feature, not something to apply silently to every run.

Also double-check `src/clickupTools.ts` against your connector's actual current tool list before trusting the write-block. It's a blocklist built from the tool set visible when this was written — if your ClickUp MCP server has since added a write-capable tool not in that list, PM would not be blocked from using it.

## Usage

`pmctl` never creates or deletes branches itself — that stays the PO's call. By default it also doesn't create a worktree: it runs PM/Dev/Reviewer/Tester directly in whatever branch you already have checked out.

```bash
cd your-backend-repo
git checkout -b add-dark-mode   # or just stay on whatever branch you're already on
pmctl run add-dark-mode --clickup "https://app.clickup.com/t/9018044177/DSAG-218"
```

`--clickup` takes either a full ClickUp task URL (custom IDs like `DSAG-218` included — just paste the URL as it appears in your browser) or a bare task id.

This will:

1. Record the feature against your current branch (no new branch, no new worktree, no port reassignment — it's literally the directory you're standing in)
2. Start a PM session (a `claude` subprocess with its own bash access, using your existing ClickUp connector) that follows `roles/pm.md`: fetch the ClickUp task itself and write `spec.md` → plan → write `plan.md` → **stop and wait for your approval** → dispatch Dev → dispatch Reviewer (code review, blocks on FAIL) → dispatch Tester (real e2e) → loop on failure → final summary

PM never hands work from one agent to the next without you approving that hand-off first: the plan before Dev, Dev's summary before Reviewer, the review before Tester, the test report before the run closes, and any failure before another round of Dev. Each is one PM invocation that does exactly one stage and stops — see the next section for how that works. (Gates only apply in the interactive terminal UI; the non-TTY/piped fallback has nobody to ask, so it runs straight through with no stopping point — see "Watching it work" below.)

### Running more than one feature at once

If you want two features worked on in parallel without them colliding on files or dev-server ports, pass `--isolate`. This is the only case where `pmctl` touches git worktrees — and even then, it still won't create the branch for you:

```bash
git branch feature/add-dark-mode   # create it yourself first
pmctl run add-dark-mode --clickup "..." --isolate
```

`--isolate` expects a branch named `feature/<feature>` to already exist (override the name with `--branch <name>`), creates a separate git worktree (`../your-backend-repo-add-dark-mode`) checked out to it, and assigns it its own dev server port. If the branch doesn't exist, `pmctl run --isolate` fails immediately with a clear error instead of creating one for you.

### Watching it work — one terminal, no second window needed

When stdin/stdout are a real terminal, `pmctl run` itself opens a live Ink UI that fills the screen: a todo-style checklist against the PM→Dev→Reviewer→Tester pipeline on the left (polled once a second from the same log `pmctl log`/`status` read), PM's own raw session output next to it, and — on terminals ≥100 columns wide — a third panel that auto-switches to whichever sub-agent is currently active (Dev, Reviewer, or Tester), so you can actually read what PM told it to do and what it answered, instead of that exchange being buried unreadable inside PM's own output. On narrower terminals that third panel is dropped rather than cramming three unreadable columns in; widen the terminal to get it back. `Ctrl+C` kills the PM session and exits; once PM finishes, press `q` or `Enter` to close the UI (its exit code becomes `pmctl run`'s own exit code). There's no second terminal to open for this — you're already looking at it.

A ticked checklist tells you which stage you're at but not whether anything is still moving, which is the question you actually have when you glance over after lunch. So the checklist also carries time and words: the in-flight step shows how long it's been in flight (`43s`, `12m`), turning red past ten minutes — not a timeout, nothing acts on it, just the point where "is it stuck?" stops being paranoia — the header shows how long the whole run has been going, and below the checklist a dimmed line quotes the newest log entry's `reason`, so you get the agent's own account of what it's doing rather than inferring it from a box. All of it comes from the log that was already being written; nothing new is recorded to produce it.

PM's transcript scrolls past faster than you can read it, so the pane keeps history you can go back through: press `[` to enter scrollback (it opens where the live view was, so nothing jumps), then `k`/`j` by line, `Ctrl-U`/`Ctrl-D` by half a screen, `Ctrl-B`/`Ctrl-F` by a full screen, `g`/`G` for the ends, and `q`/`Esc` to return to live. Output keeps streaming in behind the scrolled view instead of yanking it back to the bottom. The keys are the ones [saaio](https://saaio.dev/docs/ui/) uses for the same job, since that's where this workflow's shape came from in the first place.

Each session panel also shows what that session is and what it cost. For Dev/Reviewer/Tester: context tokens (cache reads included — they're still context the model had to read, and excluding them makes a long session look deceptively small) with a rough percentage of a 200k window, output tokens, turns, wall time and dollar cost, turning red past 75% of the window. Those numbers come from the `--output-format json` envelope, which the CLI writes when a session *ends*, so they appear once that agent finishes rather than ticking live; the alternative format streams usage per turn but would turn the readable transcript into events to reassemble, and the transcript is the thing you actually watch. PM's own panel can't show this at all — it runs in plain-text print mode and reports no usage — so instead it states the one thing that is genuinely known: the size of the prompt pmctl composed for it, labelled as the estimate it is, excluding everything PM reads on its own afterwards. The same table goes into `report.html` at the end.

Each sub-agent panel also shows its **brief** — what PM actually dispatched it to do. PM builds the real prompt inside its own bash call, which pmctl never sees, so this is the `dev_started`/`reviewer_started`/`tester_started` log line, which `roles/pm.md` requires to state the task, the file and the scope concretely. It's the only thing that tells you what the wall of reply text in that panel is replying to.

Long runs are meant to be walked away from, so the three moments that need you back — the plan-approval gate opening, PM logging `needs_po_attention`, and the run finishing — ring the terminal bell and ask it to raise a desktop notification (OSC 9 and OSC 777, which iTerm2, Windows Terminal, urxvt and others act on; everything else gets the bell, which most terminals turn into a dock bounce or a tab badge). One notification per state change, not one per poll. Set `PMCTL_NO_NOTIFY=1` to turn it all off; inside tmux, the escape sequences need `allow-passthrough` on, though the bell works regardless.

Each stage is its own PM invocation that does that stage and stops, and between them `pmctl run` parks at a **gate**: the full-screen view of what the last agent produced, with a question and `y`/`n`. The gates are the plan (`plan.md`), Dev's hand-off (`dev-summary.md`), the code review (`review.md`), the test report (`report.md`), and — when Reviewer or Tester reports a failure — whether to send it back to Dev at all. That last one matters: PM used to decide a retry by itself, so a wrong spec or a wrong test quietly burned iterations; now it reports the failure and stops, and you decide whether another round of Dev is actually the answer.

PM is instructed (`roles/pm.md`) to stop at each of these — but an LLM following a "stop now" instruction isn't a guarantee, and a real run showed PM carrying on past its stopping point. So pmctl doesn't wait for the process to exit before reacting: the moment a gate's step shows up in the log (polled once a second, same as the checklist), it kills that invocation — it has nothing left it should be doing — and opens the gate. That kill is also what stops a disobedient PM from running the whole chain in one go.

At a gate: **`y` or Enter** approves and starts the next stage, **`a`** types an answer first (see below), **`n`** stops the run there. Scroll the document with arrows/`j`/`k`/`space`/`b` and `g`/`G`. Nothing is lost by stopping — re-running `pmctl run <feature> --clickup ...` reopens the same gate without spawning anything or redoing finished work, so "stop, read it properly, come back" is a supported way to use this.

PM is a filter on questions, not a pipe for them. Dev, Reviewer and Tester write their open questions under a "คำถามถึง PM" heading — addressed to PM, never to the PO, since they can't know what sits inside PM's authority — and `roles/pm.md` requires PM to triage each one before the gate opens: anything answerable from the spec, the plan or the code, and every technical or implementation call, PM decides itself and records under "การตัดสินใจของ PM" in `plan.md`, rewriting the agent's question into the answer so the PO doesn't meet a question that's already been settled. Only genuine product decisions reach the PO — client-owned wording, user-visible behaviour the spec doesn't cover, scope or cost, anything hard to reverse — and those come with PM's own default, so approving means agreeing rather than filling in a form. Delegation only works if it's visible, hence the recorded decisions; and since an instruction to a model isn't a guarantee, a "คำถามถึง PM" heading that survives to a gate (with anything other than "ไม่มี" under it) is flagged in the panel as PM having passed a decision through instead of making it.

Approving doesn't make the document disappear for good: the path stays on screen and **`v`** reopens it in the browser, because "wait, what did I just approve?" is a question you get to have after pressing `y`, not only before.

While a stage runs, the checklist alone can't tell you what's happening — it's derived from the log, so between approving a gate and the next agent writing its first log line it still points at the stage that just finished, which makes a PM that's merely booting look like one that's wedged. So the panel also shows what pmctl actually dispatched (`▶ กำลังรัน: สั่ง Reviewer ตรวจโค้ด`) and whether that invocation has logged anything of its own yet. If it hasn't after 90 seconds, pmctl says so and names both candidates, because from outside they're identical: PM may still be thinking, or it may be blocked on a tool-permission prompt that nothing in a headless `-p` session can answer. When the output has also mentioned permissions, it says that's the likely one. The way out of the second case is `Ctrl+C` and a re-run with `--permission-mode bypassPermissions`, which resumes at the same gate with no finished work lost.

Each PM invocation (any phase) is also watched for a transient, server-side API failure — a 529 "overloaded" response, a rate limit, a 5xx gateway error, a dropped connection — and not just PM's own work going wrong. These have nothing to do with the plan or the feature; retrying shortly is the whole fix. On a non-zero exit that looks like one of these, `pmctl run` automatically retries the same invocation (up to 5 times, with a growing delay — 5s/15s/30s/60s/60s) and shows a line in the PM panel saying so, instead of ending the run and leaving you to notice the exit code and re-run it by hand. If it's still failing after 5 attempts, or the failure doesn't match a known transient pattern, it ends the run normally so you can see the real error.

Every gate writes its own artifact next to the markdown it renders — `plan.html`, `dev.html`, `review.html`, `test.html` — and best-effort opens it in your default browser (`open`/`xdg-open`/`start`). Each is self-contained: a flow chart of the pipeline coloured by where the run actually is, the stage's own document rendered properly (headings, tables, code, and ```` ```mermaid ```` as a real diagram), and from the Dev gate onward a timeline of everything logged so far, since mid-run "how did we get here" is part of the decision. They're read-only — you still approve from the terminal — and opening them is pure convenience: over SSH or with no GUI, nothing opens and the scrollable terminal view carries the same content.

When the run finishes, pmctl writes `report.html`: the plan, Dev's summary, the review, the test report and the full timeline in one page, and opens it. The terminal prints its path too. Before this, a finished run left you with a scrolled-past terminal and four markdown files in a dot-directory — nothing to open, keep, or send to anyone.

PM sometimes writes a "## คำถามถึง PO" (or "Questions to/for PO") section into `plan.md` when it needs a product decision only you can make — not everything PM needs to know fits in a plan it writes unprompted. `plan.html` is static, so it can't take an answer; it just flags the section if it finds one and points back at the terminal. There, press **`a`** on the approval screen to switch into a free-text box (type normally, `Enter` for a new line, `Esc` to save and approve — this writes what you typed to `.pmctl/<feature>/answers.md` and immediately starts the post-approval PM invocation, same as pressing `y`). The next PM invocation is instructed to read `answers.md` first, before dispatching Dev, and fold your answers into `plan.md` under a new "## คำตอบจาก PO" section so they're on the record and actually reach Dev's instructions — not just sit unread. Pressing `y` without typing anything still works exactly as before; PM falls back to its own judgment on any open question.

When stdin/stdout aren't a real TTY (piped output, CI, `pmctl run` invoked from another script), there's no screen to show the plan or a key to press, so this falls back to the old all-in-one behavior: plain text streaming straight to stdout, PM runs end-to-end with no approval gate at all. Keep agentic, unattended runs like this to low-stakes features, or review `plan.md` yourself through some other channel before it gets this far.

You can still inspect progress from elsewhere at any point without interrupting PM, e.g. from another terminal or machine:

```bash
pmctl status                 # every feature currently in flight, with its last log entry
pmctl log add-dark-mode      # full append-only log: who did what, and why
pmctl plan add-dark-mode     # PM's plan.md
pmctl review add-dark-mode   # Reviewer's review.md
pmctl report add-dark-mode   # Tester's report.md
pmctl watch                  # live Ink dashboard of every feature at once (not just the one you're running here)
```

`pmctl watch` is the multi-feature view — useful when several features are in flight (typically with `--isolate`) and you want one screen covering all of them, or you're checking in from a different terminal/session than the one running `pmctl run`. Same interactive-TUI/plain-fallback split as above (`pmctl watch --plain` forces the plain mode).

If the ClickUp task changes after the feature has started:

```bash
pmctl refresh-spec add-dark-mode --clickup "https://app.clickup.com/t/9018044177/DSAG-218"
```

(this spawns a short one-off `claude` call that re-fetches via the connector and overwrites `spec.md`, same write-blocklist applied)

Once merged, clean up:

```bash
pmctl clean add-dark-mode    # removes the worktree (--isolate runs only); .pmctl/<feature>/ (log, plan, report) is kept
```

## Files produced per feature

```
.pmctl/add-dark-mode/
  meta.json       # branch, worktree path, port, ClickUp task id
  spec.md         # ClickUp snapshot — PM reads this, never writes to it
  plan.md         # written by PM before Dev starts
  review.md       # written by Reviewer before Tester is allowed to run
  report.md       # written by Tester after running real tests
  log.ndjson      # append-only; every PM/Dev/Reviewer/Tester milestone, with reasons
  pm-session.log      # raw transcript of the PM session, for deep debugging
  dev-session.log      # raw --output-format json transcript of Dev's latest invocation
  reviewer-session.log # same, for Reviewer's latest invocation
  tester-session.log   # same, for Tester's latest invocation
```

The three `*-session.log` files are overwritten (not appended) on each new invocation — they always reflect that agent's current/latest round, not a combined history across iterations; `log.ndjson` is the durable cross-round record. `pmctl run`'s third panel (see above) tails whichever one matches the currently active agent.

## Known limitations

- **"Read-only ClickUp access" is a blocklist, not a structural guarantee.** `src/clickupTools.ts` names every write-capable ClickUp MCP tool visible when this was written, passed to `--disallowedTools`. If the ClickUp connector adds a new write tool later and this list isn't updated, PM would not be blocked from using it. Re-check it periodically. (An earlier version of this tool used a manually-exported `CLICKUP_API_TOKEN` that was never forwarded to subprocesses — a stronger, credential-level guarantee, at the cost of one extra setup step and not reusing your existing connector. Revert to that approach in `src/agents.ts`/`roles/pm.md` if the blocklist's weaker guarantee isn't acceptable for your use case.)
- Not yet fully validated end-to-end against a live `claude` CLI — the environment this was built in doesn't have Claude Code installed. One real run did surface a concrete problem that's now fixed: PM's nested `claude -p ...` calls to spawn Dev/Reviewer/Tester were rejected outright because `roles/pm.md` used `$(cat <role file>)` inside the bash command — Claude Code's Bash tool refuses command substitution like that on sight, since it can't verify the substituted content for safety. Fixed by having PM read each role file with its own Read tool first and paste the content in literally. A second, separate failure ("this command requires approval") can also show up the first time, if the worktree's `.claude/settings.local.json` has no allow rule for invoking `claude` via Bash — `src/claudeSettings.ts` now best-effort adds one (`Bash(claude -p *)`, anchored to the actual subcommand PM uses rather than a bare wildcard right after `claude`, after Claude Code itself flagged an earlier, broader version of this rule as unsafe) before PM starts, but that exact syntax is still a guess, not verified against a real CLI. If you still hit it, run `claude` once interactively in the worktree, deliberately trigger that same approval prompt, and choose "always allow" — the CLI will write the correct syntax into that same file itself. Beyond this, the worktree/port/log mechanics are tested and working; expect to adjust other flags, tool names, or prompt wording as you hit them on first use.
- No sandboxing beyond what `--disallowedTools` gives you (the ClickUp write-block) and whatever `--permission-mode` you choose. `acceptEdits` auto-accepts file changes from Dev with no human in the loop; `bypassPermissions` (opt-in only, see above) removes the approval step from *every* tool call, Bash included, inside whatever worktree `pmctl run` set up — a real checkout with real file-system access, not a sandbox. For anything touching production data, paying customers, or credentials reachable from that worktree, that's a real trade-off: either accept that a stricter mode may hang on an unapproved Bash command (nothing can answer the prompt in this headless flow), or review the diff yourself before merging regardless of what Tester reports.
- The Dev/Reviewer/Tester panel in `pmctl run` shows the raw `--output-format json` reply as-is — readable as *which* panel is active, but not guaranteed to be pretty-printed prose, since this was built without a real `claude` CLI to check that format against. If it renders as one dense JSON blob instead of readable turns on your installed version, that's a formatting gap, not a bug in which agent is shown; pretty-printing it properly needs the real JSON shape to build against.
- Stopping at every hand-off is the point, but it is also the cost: a feature that used to be one approval away from a finished run now needs five. There's no `--auto` to skip them in the TUI — if you want the old straight-through behaviour, pipe the output (`pmctl run ... | cat`), which takes the non-TTY path and runs end to end with no gates and no artifacts per stage. That path has no human in it at all, so keep it for low-stakes work.
- Each stage being its own `claude -p` invocation means each one starts cold: PM re-reads `plan.md`, `dev-summary.md`, `review.md` and so on rather than carrying a conversation across stages. That's what makes the gates possible (a `-p` session can't pause for a human), and it's why those files matter — anything an agent doesn't write down is genuinely gone by the next stage. If an agent skips its file, the gate still opens and says so instead of silently showing you nothing.
- `log.ndjson` is written by an LLM, so it's treated as untrusted input on read: lines that aren't valid JSON are skipped and counted rather than parsed blindly. They used to be parsed blindly — one `reviewer_done` line with a control character in its `reason` threw inside the once-a-second poll and took down a whole run whose work was entirely safe on disk. A skipped line is still a real loss (that milestone becomes invisible to the checklist and the gates), so the count is shown in the panel instead of being swallowed.
- PM appends log lines with `pmctl log-append --step ... --reason ...` rather than `echo '{...}' >>`, so the JSON encoding is done by `JSON.stringify` and not by an LLM assembling quotes in bash around several sentences of Thai. `pmctl log-append` exists for that one purpose and isn't meant to be run by hand.
- Desktop notifications are a request, not a guarantee: pmctl writes the bell plus OSC 9 and OSC 777 and lets the terminal decide. Terminal.app and Alacritty support neither OSC sequence and only get the bell; tmux swallows both without `allow-passthrough`. If yours renders them as visible garbage instead of ignoring them, set `PMCTL_NO_NOTIFY=1` — nothing else in the TUI depends on it.
- The checklist's "is it stuck?" signals are heuristics over the log, not process supervision. The age counts time since the last pipeline log line, so an agent that's working hard without logging a milestone looks identical to one that's genuinely wedged; the ten-minute red threshold is a fixed guess, not tuned to what Dev or a full e2e run actually takes on your repo. Treat a red number as a reason to look at the PM pane, not as a verdict.
- `plan.html`'s markdown renderer (`src/planHtml.ts`) only handles what `roles/pm.md` actually asks PM to write — headings, bullet/numbered lists, pipe tables, fenced code blocks (```` ```mermaid ```` renders as a real diagram via mermaid.js, any other/no language as plain preformatted text), `**bold**`, `` `code` ``, plain paragraphs — not arbitrary markdown (no nested lists, no links, no blockquotes). If PM's plan prose grows to use something outside that set, it'll show up as a plain paragraph rather than rendering specially, not corrupt the page. The mermaid diagram needs the viewer's browser to reach `cdn.jsdelivr.net`; with no internet it just shows the raw diagram source as text instead of a rendered chart — not broken, just not drawn.
- The transient-API-error retry (`TRANSIENT_ERROR_PATTERNS` in `src/runView.tsx`) matches on the text a known overload/rate-limit/gateway/connection error actually prints — built from the one real 529 message seen so far, not a reference list from Anthropic. A transient failure that doesn't match any pattern still ends the run and shows its real exit code/output rather than silently retrying forever or misreporting it as something else.
