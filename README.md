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
| ClickUp is write-only for the PO; PM only reads it | PM uses your own already-authenticated ClickUp MCP connector to read a task, but is spawned with `--disallowedTools` naming every write-capable ClickUp tool (`src/clickupTools.ts`) — Claude Code's own permission system refuses the call if PM tries one. This is a blocklist, not a withheld credential; see "Known limitations" |
| The working log is never stored in ClickUp | Every milestone is appended to a local, append-only `.pmctl/<feature>/log.ndjson` — plain files the PO can read any time without waiting on a summary |
| PM must plan before dispatching Dev | `roles/pm.md` requires `plan.md` (goal, approach, flow, affected files) to exist before Dev is invoked, for every feature regardless of size |
| Tester must prove it, not assert it | `roles/tester.md` forbids a pass verdict based on reading code; it must run the unit suite, then execute real e2e scenarios against a running instance, and cite command output as evidence in `report.md` |
| Plan and test report are separate artifacts | `plan.md` is owned by PM, `report.md` is owned by Tester — each one documents one side of the work |

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

and compare against what's used in `src/agents.ts` and `roles/pm.md`. If something's changed, `roles/pm.md` is the only file to edit — PM constructs its own calls to Dev and Tester from that template via its bash tool, so a flag change doesn't require touching any TypeScript.

`--permission-mode acceptEdits` is the default, so file edits are accepted without an interactive prompt (this runs unattended). Pass `--permission-mode <mode>` to `pmctl run` to tighten or loosen that for a given feature.

Also double-check `src/clickupTools.ts` against your connector's actual current tool list before trusting the write-block. It's a blocklist built from the tool set visible when this was written — if your ClickUp MCP server has since added a write-capable tool not in that list, PM would not be blocked from using it.

## Usage

`pmctl` does not create or delete branches itself — that stays the PO's call. Create the branch yourself first:

```bash
cd your-backend-repo
git branch feature/add-dark-mode   # or: git checkout -b feature/add-dark-mode
pmctl run add-dark-mode --clickup "https://app.clickup.com/t/9018044177/DSAG-218"
```

`--clickup` takes either a full ClickUp task URL (custom IDs like `DSAG-218` included — just paste the URL as it appears in your browser) or a bare task id.

By default `pmctl run <feature>` expects a branch named `feature/<feature>` to already exist. Use a different name with `--branch <name>` (the branch still must already exist — pass this instead of renaming your feature to match a branch you already have):

```bash
pmctl run add-dark-mode --clickup "..." --branch chore/dark-mode-toggle
```

If the branch doesn't exist yet, `pmctl run` fails immediately with a clear error instead of creating one for you.

This will:

1. Create a new git worktree (`../your-backend-repo-add-dark-mode`) checked out to that existing branch, with an auto-assigned dev server port
2. Start a PM session (a `claude` subprocess with its own bash access, using your existing ClickUp connector) that follows `roles/pm.md`: fetch the ClickUp task itself and write `spec.md` → plan → write `plan.md` → dispatch Dev → dispatch Tester (real e2e) → loop on failure → final summary

You can inspect progress at any point without interrupting PM:

```bash
pmctl status                 # every feature currently in flight, with its last log entry
pmctl log add-dark-mode      # full append-only log: who did what, and why
pmctl plan add-dark-mode     # PM's plan.md
pmctl report add-dark-mode   # Tester's report.md
pmctl watch                  # live-refreshing view of every feature and which agent is doing what, right now
```

`pmctl watch` is meant to run in a second terminal alongside `pmctl run`. When stdin/stdout are a real terminal, it's an interactive TUI (built with [Ink](https://github.com/vadimdemedes/ink)): a feature list on the left (↑/↓ to select, `q` to quit) and that feature's live log on the right, color-coded by step. It polls the same `log.ndjson` files `pmctl log`/`status` read — no separate state, no extra process to keep in sync.

When stdin/stdout aren't a TTY (piped output, CI, this tool running inside another script), it automatically falls back to a plain, non-interactive dashboard that just redraws on an interval — Ink needs real terminal raw-mode support that isn't available there. Force the plain mode yourself with `pmctl watch --plain`.

If the ClickUp task changes after the feature has started:

```bash
pmctl refresh-spec add-dark-mode --clickup "https://app.clickup.com/t/9018044177/DSAG-218"
```

(this spawns a short one-off `claude` call that re-fetches via the connector and overwrites `spec.md`, same write-blocklist applied)

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

- **"Read-only ClickUp access" is a blocklist, not a structural guarantee.** `src/clickupTools.ts` names every write-capable ClickUp MCP tool visible when this was written, passed to `--disallowedTools`. If the ClickUp connector adds a new write tool later and this list isn't updated, PM would not be blocked from using it. Re-check it periodically. (An earlier version of this tool used a manually-exported `CLICKUP_API_TOKEN` that was never forwarded to subprocesses — a stronger, credential-level guarantee, at the cost of one extra setup step and not reusing your existing connector. Revert to that approach in `src/agents.ts`/`roles/pm.md` if the blocklist's weaker guarantee isn't acceptable for your use case.)
- Not yet validated end-to-end against a live `claude` CLI — the environment this was built in doesn't have Claude Code installed, so `--disallowedTools` blocking the right tool names has not been confirmed against a real ClickUp connector either. The worktree/port/log mechanics are tested and working; the PM→Dev→Tester loop and the tool-blocking has only been verified at the level of "does it assemble the right command," not a real run. Expect to adjust flags, tool names, or prompt wording on first use.
- No sandboxing beyond what `--permission-mode` and `--disallowedTools` give you. `acceptEdits` auto-accepts file changes from Dev with no human in the loop — for anything touching production data or paying customers, use a stricter permission mode or review the diff before merging regardless of what Tester reports.
