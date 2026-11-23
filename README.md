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
2. Start a PM session (a `claude` subprocess with its own bash access, using your existing ClickUp connector) that follows `roles/pm.md`: fetch the ClickUp task itself and write `spec.md` → plan → write `plan.md` → **stop and wait for your approval** → dispatch Dev → dispatch Reviewer (code review, blocks on FAIL) → dispatch Tester (real e2e) → loop on failure → final summary

PM never dispatches Dev without you explicitly approving the plan first — see the next section for how that approval works. (This gate only applies in the interactive terminal UI; the non-TTY/piped fallback has no way to show you anything to approve, so it runs straight through with no stopping point — see "Watching it work" below.)

### Running more than one feature at once

If you want two features worked on in parallel without them colliding on files or dev-server ports, pass `--isolate`. This is the only case where `pmctl` touches git worktrees — and even then, it still won't create the branch for you:

```bash
git branch feature/add-dark-mode   # create it yourself first
pmctl run add-dark-mode --clickup "..." --isolate
```

`--isolate` expects a branch named `feature/<feature>` to already exist (override the name with `--branch <name>`), creates a separate git worktree (`../your-backend-repo-add-dark-mode`) checked out to it, and assigns it its own dev server port. If the branch doesn't exist, `pmctl run --isolate` fails immediately with a clear error instead of creating one for you.

### Watching it work — one terminal, no second window needed

When stdin/stdout are a real terminal, `pmctl run` itself opens a live Ink UI that fills the screen: a todo-style checklist against the PM→Dev→Reviewer→Tester pipeline on the left (polled once a second from the same log `pmctl log`/`status` read), PM's own raw session output next to it, and — on terminals ≥100 columns wide — a third panel that auto-switches to whichever sub-agent is currently active (Dev, Reviewer, or Tester), so you can actually read what PM told it to do and what it answered, instead of that exchange being buried unreadable inside PM's own output. On narrower terminals that third panel is dropped rather than cramming three unreadable columns in; widen the terminal to get it back. `Ctrl+C` kills the PM session and exits; once PM finishes, press `q` or `Enter` to close the UI (its exit code becomes `pmctl run`'s own exit code). There's no second terminal to open for this — you're already looking at it.

PM's first invocation always stops after writing `plan.md`, never dispatching Dev in that same call. At that point the TUI switches to a full-screen approval view — starting at the top of the plan (scroll with arrows/`j`/`k`/`space`/`b`, jump with `g`/`G`), with `#` headings picked out so the plan's structure reads at a glance — with a prompt: press **`y` or Enter to approve** (this spawns a second PM invocation that picks up right at dispatching Dev, skipping the ClickUp fetch/plan steps since they're already done) or **`n` to reject** (exits; edit `plan.md` by hand and run `pmctl run <feature> --clickup ...` again on the same feature — it detects the existing plan and reopens the same approval prompt immediately, without re-fetching the spec or re-planning). If you rerun a feature where Dev was already dispatched at some point in an earlier attempt, pmctl treats the plan as already (implicitly) approved and continues straight from Dev rather than asking again.

At the same moment, pmctl also writes `.pmctl/<feature>/plan.html` — a self-contained page with a real flow chart of the PO→PM→Dev→Reviewer→Tester pipeline (colored by status, with the Dev/Reviewer/Tester retry loop drawn as its own box) plus the plan itself rendered from markdown (headings, tables, bold, code) instead of raw text — and best-effort opens it in your OS's default browser (`open`/`xdg-open`/`start`). That page is read-only — you still approve or reject from the terminal — and opening it is pure convenience: over SSH, in a container, or on a machine with no GUI/browser opener installed, nothing opens and pmctl says so in the terminal, but the scrollable plan view there is the same content and isn't blocked by it.

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
- No sandboxing beyond what `--permission-mode` and `--disallowedTools` give you. `acceptEdits` auto-accepts file changes from Dev with no human in the loop — for anything touching production data or paying customers, use a stricter permission mode or review the diff before merging regardless of what Tester reports.
- The Dev/Reviewer/Tester panel in `pmctl run` shows the raw `--output-format json` reply as-is — readable as *which* panel is active, but not guaranteed to be pretty-printed prose, since this was built without a real `claude` CLI to check that format against. If it renders as one dense JSON blob instead of readable turns on your installed version, that's a formatting gap, not a bug in which agent is shown; pretty-printing it properly needs the real JSON shape to build against.
- `plan.html`'s markdown renderer (`src/planHtml.ts`) only handles what `roles/pm.md` actually asks PM to write — headings, bullet lists, pipe tables, `**bold**`, `` `code` ``, plain paragraphs — not arbitrary markdown (no nested lists, no fenced code blocks, no links). If PM's plan prose grows to use something outside that set, it'll show up as a plain paragraph rather than rendering specially, not corrupt the page.
