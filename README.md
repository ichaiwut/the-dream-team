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
| ClickUp is write-only for the PO; PM only reads it | PM uses your own already-authenticated ClickUp MCP connector to read a task, but is spawned with `--disallowedTools` naming every write-capable ClickUp tool (`src/clickupTools.ts`) — Claude Code's own permission system refuses the call if PM tries one. This is a blocklist, not a withheld credential; see "Known limitations" |
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

`--permission-mode acceptEdits` is the default, so file edits are accepted without an interactive prompt (this runs unattended). Pass `--permission-mode <mode>` to `pmctl run` to tighten or loosen that for a given feature.

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
2. Start a PM session (a `claude` subprocess with its own bash access, using your existing ClickUp connector) that follows `roles/pm.md`: fetch the ClickUp task itself and write `spec.md` → plan → write `plan.md` → dispatch Dev → dispatch Reviewer (code review, blocks on FAIL) → dispatch Tester (real e2e) → loop on failure → final summary

### Running more than one feature at once

If you want two features worked on in parallel without them colliding on files or dev-server ports, pass `--isolate`. This is the only case where `pmctl` touches git worktrees — and even then, it still won't create the branch for you:

```bash
git branch feature/add-dark-mode   # create it yourself first
pmctl run add-dark-mode --clickup "..." --isolate
```

`--isolate` expects a branch named `feature/<feature>` to already exist (override the name with `--branch <name>`), creates a separate git worktree (`../your-backend-repo-add-dark-mode`) checked out to it, and assigns it its own dev server port. If the branch doesn't exist, `pmctl run --isolate` fails immediately with a clear error instead of creating one for you.

### Watching it work — one terminal, no second window needed

When stdin/stdout are a real terminal, `pmctl run` itself opens a live Ink UI: PM's raw output streams in a panel on the left, and this feature's step log (the same thing `pmctl log`/`status` show) updates next to it on the right, polled once a second. `Ctrl+C` kills the PM session and exits; once PM finishes, press `q` or `Enter` to close the UI (its exit code becomes `pmctl run`'s own exit code). There's no second terminal to open for this — you're already looking at it.

When stdin/stdout aren't a real TTY (piped output, CI, `pmctl run` invoked from another script), it falls back to the old plain text streaming straight to stdout — Ink needs real terminal raw-mode support that isn't available there.

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
  pm-session.log  # raw transcript of the PM session, for deep debugging
```

## Known limitations

- **"Read-only ClickUp access" is a blocklist, not a structural guarantee.** `src/clickupTools.ts` names every write-capable ClickUp MCP tool visible when this was written, passed to `--disallowedTools`. If the ClickUp connector adds a new write tool later and this list isn't updated, PM would not be blocked from using it. Re-check it periodically. (An earlier version of this tool used a manually-exported `CLICKUP_API_TOKEN` that was never forwarded to subprocesses — a stronger, credential-level guarantee, at the cost of one extra setup step and not reusing your existing connector. Revert to that approach in `src/agents.ts`/`roles/pm.md` if the blocklist's weaker guarantee isn't acceptable for your use case.)
- Not yet validated end-to-end against a live `claude` CLI — the environment this was built in doesn't have Claude Code installed, so `--disallowedTools` blocking the right tool names has not been confirmed against a real ClickUp connector either. The worktree/port/log mechanics are tested and working; the PM→Dev→Reviewer→Tester loop and the tool-blocking has only been verified at the level of "does it assemble the right command," not a real run. Expect to adjust flags, tool names, or prompt wording on first use.
- No sandboxing beyond what `--permission-mode` and `--disallowedTools` give you. `acceptEdits` auto-accepts file changes from Dev with no human in the loop — for anything touching production data or paying customers, use a stricter permission mode or review the diff before merging regardless of what Tester reports.
