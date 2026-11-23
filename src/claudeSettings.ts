import fs from "node:fs";
import path from "node:path";

const SETTINGS_REL_PATH = path.join(".claude", "settings.local.json");

// The exact allow-rule syntax here is a best-effort guess, not something
// verified against the real claude CLI — this project has never had one
// installed to check against (see README's Known limitations). The pattern
// is modeled on the one confirmed real example we've actually seen: a user's
// own PM session output showed an existing rule shaped like
// `Bash(cp /tmp/pdf-images/img-*.png /Us...)`, i.e. `Bash(<command prefix>)`.
//
// If PM still hits "This command requires approval" for its nested
// `claude -p ...` calls after this, the reliable fix is to run `claude`
// once *interactively* inside the worktree, deliberately trigger that same
// approval prompt for a `claude -p ...` command, and choose "always allow" —
// the CLI will then write the exact correct syntax into this same file
// itself. This function's own entry just sits alongside it harmlessly
// either way, since it only ever adds, never removes or overwrites.
const CLAUDE_BASH_ALLOW_RULE = "Bash(claude *)";

/**
 * Best-effort, additive-only: ensures the worktree's
 * .claude/settings.local.json allow-lists invoking `claude` via Bash, so
 * PM's nested `claude -p ...` calls (to spawn Dev/Reviewer/Tester) don't
 * hang waiting on an interactive approval prompt that can never come in a
 * headless (`-p`) PM session — there's no human attached to answer it.
 *
 * Never removes or overwrites any existing rule in the file; merges in one
 * entry if it's missing. Any failure (unreadable file, unexpected JSON
 * shape, permission error) is swallowed — this is a convenience that might
 * not even be needed on every setup (some permission modes may not require
 * it), not something that should abort a run over.
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
    if (!settings.permissions.allow.includes(CLAUDE_BASH_ALLOW_RULE)) {
      settings.permissions.allow.push(CLAUDE_BASH_ALLOW_RULE);
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
    }
  } catch {
    // Best-effort only — see doc comment above.
  }
}
