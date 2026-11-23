# pmctl

A local CLI orchestrator for a strict PO → PM → Dev → Tester agent chain, built on top of [Claude Code](https://claude.com/claude-code). Inspired by [saaio](https://saaio.dev/)'s worktree-per-flow model, scoped down to a single accountable chain instead of a multi-worker TUI.

## Why

Giving one agent full autonomy over a feature — writing the code, testing it, and deciding it's done — means the same model grades its own work. `pmctl` splits that into three roles with a hard communication boundary, and gives the human (PO) a durable, auditable trail without needing to sit in on every exchange:

- **PO** (you) — owns the spec in ClickUp and signs off on acceptance testing. Never talks to Dev or Tester directly.
- **PM** (agent) — reads the spec, writes a plan before any code is touched, dispatches Dev and Tester, and is the only role that talks to either of them.
- **Dev** (agent) — implements against PM's instructions inside an isolated git worktree. Has no path to reach the PO.
- **Tester** (agent) — independently verifies Dev's work by actually running tests (unit, then real e2e), not by reading the diff and approving it.

## Design rules this tool enforces

| Rule | How it's enforced |
|---|---|
| ClickUp is write-only for the PO; PM only reads it | `CLICKUP_API_TOKEN` is read once by the `pmctl` parent process and deliberately never forwarded into the environment of any spawned `claude` subprocess — PM, Dev, and Tester have no credential to write back even if instructed to |
| The working log is never stored in ClickUp | Every milestone is appended to a local, append-only `.pmctl/<feature>/log.ndjson` — plain files the PO can read any time without waiting on a summary |
| PM must plan before dispatching Dev | `roles/pm.md` requires `plan.md` (goal, approach, flow, affected files) to exist before Dev is invoked, for every feature regardless of size |
| Tester must prove it, not assert it | `roles/tester.md` forbids a pass verdict based on reading code; it must run the unit suite, then execute real e2e scenarios against a running instance, and cite command output as evidence in `report.md` |
| Plan and test report are separate artifacts | `plan.md` is owned by PM, `report.md` is owned by Tester — each one documents one side of the work |

## Requirements

- Node.js >= 18
- [Claude Code](https://claude.com/claude-code) (`claude` CLI) installed and authenticated
- A git repository to run features against (this repo, `pmctl` itself, is just where the tool's source lives — you run it *inside* the project you're building)
- A ClickUp API token with read access to the tasks you'll use as specs

## Install

```bash
git clone git@github.com:ichaiwut/the-dream-team.git
cd the-dream-team
npm install
npm run build
npm link        # exposes `pmctl` globally; or invoke node dist/cli.js directly without linking
```

## Before first real use

The `claude` CLI flags this tool shells out to (`--append-system-prompt`, `--permission-mode`, `--output-format`) were written against a general understanding of Claude Code's interface at the time this was built. Flag names can change between versions. Before running this against real work:

```bash
claude --help
```

and compare against what's used in `src/agents.ts` and `roles/pm.md`. If something's changed, `roles/pm.md` is the only file to edit — PM constructs its own calls to Dev and Tester from that template via its bash tool, so a flag change doesn't require touching any TypeScript.

`--permission-mode acceptEdits` is the default, so file edits are accepted without an interactive prompt (this runs unattended). Pass `--permission-mode <mode>` to `pmctl run` to tighten or loosen that for a given feature.

## Usage

```bash
export CLICKUP_API_TOKEN=pk_xxxxx     # the PO's own token — never shared with PM

cd your-backend-repo
pmctl run add-dark-mode --clickup 86abc123de
```

This will:

1. Create a new git worktree (`../your-backend-repo-add-dark-mode`) on branch `feature/add-dark-mode`, with an auto-assigned dev server port
2. Pull the ClickUp task into `.pmctl/add-dark-mode/spec.md` as a one-time snapshot
3. Start a PM session (a `claude` subprocess with its own bash access) that follows `roles/pm.md`: plan → write `plan.md` → dispatch Dev → dispatch Tester (real e2e) → loop on failure → final summary

You can inspect progress at any point without interrupting PM:

```bash
pmctl status                 # every feature currently in flight, with its last log entry
pmctl log add-dark-mode      # full append-only log: who did what, and why
pmctl plan add-dark-mode     # PM's plan.md
pmctl report add-dark-mode   # Tester's report.md
```

If the ClickUp task changes after the feature has started:

```bash
pmctl refresh-spec add-dark-mode --clickup 86abc123de
```

Once merged, clean up the worktree:

```bash
pmctl clean add-dark-mode    # removes the worktree; .pmctl/<feature>/ (log, plan, report) is kept
```

## Files produced per feature

```
.pmctl/add-dark-mode/
  meta.json       # branch, worktree path, port, ClickUp task id
  spec.md         # ClickUp snapshot — PM reads this, never writes to it
  plan.md         # written by PM before Dev starts
  report.md       # written by Tester after running real tests
  log.ndjson      # append-only; every PM/Dev/Tester milestone, with reasons
  pm-session.log  # raw transcript of the PM session, for deep debugging
```

## Known limitations

- "Read-only ClickUp access" is enforced at the code level (no token forwarded to subprocesses), not by a ClickUp API scope. Anyone running the same token outside this tool has full write access as normal.
- Not yet validated end-to-end against a live `claude` CLI — the environment this was built in doesn't have Claude Code installed. The worktree/port/ClickUp/log mechanics are tested and working; the PM→Dev→Tester loop has only been verified at the level of "does it assemble the right command," not a real run. Expect to adjust flags or prompt wording on first use.
- No sandboxing beyond what `--permission-mode` gives you. `acceptEdits` auto-accepts file changes from Dev with no human in the loop — for anything touching production data or paying customers, use a stricter permission mode or review the diff before merging regardless of what Tester reports.
