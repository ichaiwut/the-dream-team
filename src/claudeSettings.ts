import fs from "node:fs";
import path from "node:path";

const SETTINGS_REL_PATH = path.join(".claude", "settings.local.json");

// A first version of this file used `Bash(claude *)` — Claude Code itself
// flagged that as unsafe the moment it was loaded: a wildcard placed
// immediately after the command name also matches anything inserted at that
// exact position (e.g. an extra flag smuggled in before `-p`), so it
// silently auto-approved far more than "run claude -p ...". Narrowed to
// anchor on the actual subcommand PM always uses (`claude -p ...`, per
// roles/pm.md), with the wildcard only covering what legitimately varies
// (the prompt text and remaining flags) — per Claude Code's own guidance:
// "only use * after the subcommand." Still a guess, not verified against
// the real CLI — this project has never had one installed to check against
// (see README's Known limitations).
//
// If PM still hits "This command requires approval" for its nested
// `claude -p ...` calls after this, the reliable fix is to run `claude`
// once *interactively* inside the worktree, deliberately trigger that same
// approval prompt for a `claude -p ...` command, and choose "always allow" —
// the CLI will then write the exact correct syntax into this same file
// itself. This function's own entry just sits alongside it harmlessly
// either way.
const CLAUDE_BASH_ALLOW_RULE = "Bash(claude -p *)";

// The old, overly-broad rule from the first version of this file. Safe to
// actively remove (not just leave alongside the new one) because pmctl
// itself is the only thing that ever wrote it — never a rule the PO set up
// by hand — and leaving it in place would keep the exact hole it caused.
const SUPERSEDED_BROAD_RULE = "Bash(claude *)";

/**
 * Best-effort: ensures the worktree's .claude/settings.local.json allow-lists
 * invoking `claude -p ...` via Bash, so PM's nested calls to spawn
 * Dev/Reviewer/Tester don't hang waiting on an interactive approval prompt
 * that can never come in a headless (`-p`) PM session — there's no human
 * attached to answer it. Also migrates away the old overly-broad rule this
 * function used to write (see SUPERSEDED_BROAD_RULE above) if present.
 *
 * Otherwise additive-only: never touches any other existing rule. Any
 * failure (unreadable file, unexpected JSON shape, permission error) is
 * swallowed — this is a convenience that might not even be needed on every
 * setup (some permission modes may not require it), not something that
 * should abort a run over.
 */
export function ensureClaudeBashAllowRule(worktreePath: string): void {
  const file = path.join(worktreePath, SETTINGS_REL_PATH);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let settings: Record<string, any> = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (raw) settings = JSON.parse(raw);
    }
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return;
    settings.permissions ??= {};
    settings.permissions.allow ??= [];
    if (!Array.isArray(settings.permissions.allow)) return; // unexpected shape — don't touch it

    let changed = false;
    const broadIdx = settings.permissions.allow.indexOf(SUPERSEDED_BROAD_RULE);
    if (broadIdx !== -1) {
      settings.permissions.allow.splice(broadIdx, 1);
      changed = true;
    }
    if (!settings.permissions.allow.includes(CLAUDE_BASH_ALLOW_RULE)) {
      settings.permissions.allow.push(CLAUDE_BASH_ALLOW_RULE);
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
    }
  } catch {
    // Best-effort only — see doc comment above.
  }
}
