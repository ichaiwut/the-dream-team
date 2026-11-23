/**
 * Terminal-level "this run needs you" notifications.
 *
 * `pmctl run` is a long job you're meant to walk away from — PM plans, Dev
 * writes code, Tester runs e2e, each taking minutes. The one moment it
 * genuinely needs a human back at the keyboard (the plan-approval gate) was
 * invisible unless you happened to be watching the terminal at that second:
 * a real run sat on the approval screen unnoticed because nothing announced
 * it. This is the announcement.
 *
 * Deliberately dependency-free and best-effort. There is no portable way to
 * raise a desktop notification from a TUI, so this does what terminal
 * programs conventionally do and lets the terminal decide:
 *   - BEL (\x07): understood by every terminal. Most turn it into a dock
 *     bounce, a taskbar flash, a tab badge, or a visual bell. This alone is
 *     what Alacritty and Terminal.app get, since neither supports the OSC
 *     sequences below.
 *   - OSC 9: iTerm2 and Windows Terminal raise a real desktop notification.
 *   - OSC 777: the same for urxvt and several others.
 * Terminals that don't recognise an OSC sequence are expected to swallow it.
 * If yours instead prints it as garbage, set PMCTL_NO_NOTIFY=1 — the TUI is
 * fully usable without any of this.
 *
 * Note for tmux users: tmux swallows these unless `allow-passthrough` is on;
 * the bell still works via its own bell-action setting.
 */

const ESC = "\u001b";
const BEL = "\u0007";

function sanitize(s: string): string {
  // An OSC sequence is terminated by BEL (or ST), so anything containing a
  // control character would truncate the sequence mid-flight and leave the
  // rest of the string to be rendered as literal text into the middle of
  // Ink's frame. Log `reason` text comes from the agents, so it is not
  // guaranteed clean.
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
}

/**
 * Fire-and-forget. Writes straight to stdout rather than through Ink: these
 * are escape sequences, not rendered output, so they don't belong in the
 * component tree, and Ink repaints its own frame on the next state change
 * regardless.
 */
export function notify(title: string, body: string): void {
  if (process.env.PMCTL_NO_NOTIFY) return;
  if (!process.stdout.isTTY) return;
  try {
    const t = sanitize(title);
    const b = sanitize(body);
    process.stdout.write(BEL);
    process.stdout.write(`${ESC}]9;${t} — ${b}${BEL}`);
    process.stdout.write(`${ESC}]777;notify;${t};${b}${BEL}`);
  } catch {
    // Never let a notification take down a run.
  }
}
