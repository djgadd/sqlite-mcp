/**
 * Silence only Node's "SQLite is an experimental feature" notice, which is
 * printed to stderr when `node:sqlite` is loaded. Every other process warning
 * is forwarded to Node's original handler untouched.
 *
 * This module must be imported before anything that loads `node:sqlite`.
 *
 * Two deliberate assumptions, both fail-open (a mismatch only lets the notice
 * through again, never suppresses anything else):
 *  - The match keys on `ExperimentalWarning` + a `/SQLite/i` message. If a
 *    future Node reworded or renamed the notice the filter would stop matching
 *    and the (harmless) warning would reappear on stderr.
 *  - We snapshot and re-invoke the existing `warning` listeners; Node's default
 *    printer is registered as one of them at import time, so forwarding to the
 *    snapshot preserves default behaviour for every other warning.
 */
const originalListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) {
    return;
  }
  for (const listener of originalListeners) {
    listener(warning);
  }
});
