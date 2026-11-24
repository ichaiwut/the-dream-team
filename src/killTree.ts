import { execFileSync } from "node:child_process";

/**
 * Killing a PM invocation and everything it spawned.
 *
 * PM dispatches Dev/Reviewer/Tester as its own child `claude` processes, so
 * killing PM's pid alone leaves them running — still editing files, still
 * burning tokens, with nothing left watching them. That was already true of
 * Ctrl+C; it matters more for the PO's emergency stop, where "stop
 * everything" has to mean everything.
 *
 * Walking the tree with pgrep rather than spawning PM detached and killing
 * its process group: a detached child with inherited stdin can be stopped
 * with SIGTTIN if it ever reads from the terminal, and that failure mode
 * (a silently suspended agent) is worse than the one being fixed.
 */

/** Direct children of a pid, or [] when pgrep isn't available. */
function childrenOf(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    // pgrep exits 1 when there are no matches, which is the common case.
    return [];
  }
}

/** The pid and every descendant, deepest last. */
export function collectTree(pid: number, depth = 0): number[] {
  if (depth > 10) return [pid]; // guard against a pathological cycle
  const kids = childrenOf(pid).flatMap((c) => collectTree(c, depth + 1));
  return [pid, ...kids];
}

/**
 * SIGTERM the whole tree, then SIGKILL whatever is still alive. Children
 * are signalled before their parents so a parent can't react to a dying
 * child by starting another one.
 *
 * Best-effort throughout: a pid that's already gone throws ESRCH, which is
 * the desired state, not an error.
 */
export function killTree(pid: number): void {
  const tree = collectTree(pid).reverse();
  for (const p of tree) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      // already gone
    }
  }
  // Give them a moment to exit on their own, then insist. Deliberately
  // synchronous and short: this runs while the PO is watching a screen
  // that says everything is stopping, and it must be true by the time
  // they read it.
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const alive = tree.filter((p) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length === 0) return;
  }
  for (const p of tree) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
