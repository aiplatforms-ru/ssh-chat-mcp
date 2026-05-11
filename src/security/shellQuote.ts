/**
 * POSIX shell quoting helpers.
 *
 * These are used to safely interpolate user-supplied strings (cwd, command, runAs,
 * remote paths) into a remote shell invocation like:
 *
 *     cd <quoted cwd> && <command>
 *     sudo -S -p '' -iu <runAs> -- bash -lc <quoted command>
 *
 * The remote shell is assumed to be bash/sh on a Linux-like target.
 */

/**
 * Single-quote a string for POSIX shells.
 *
 * Strategy: wrap in single quotes, and replace every embedded single quote with
 * the standard sequence `'\''` (close-quote, escaped quote, reopen-quote).
 * This is robust against arbitrary content including newlines, `$`, backticks, etc.
 */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  // Replace ' with '\'' (close quote, escaped quote, reopen quote).
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Validate that a string is a plausible Linux username.
 *
 * Conservative ruleset (POSIX + common distro practice):
 *  - first char: lowercase letter or underscore
 *  - subsequent chars: lowercase letters, digits, `_`, `-`
 *  - length 1..32
 *
 * Returns the trimmed username, or throws on invalid input.
 *
 * This is *the* defence against `runAs` being abused to inject shell.
 * We do NOT shell-quote runAs and rely on it directly inside `sudo -iu <name>`,
 * so it MUST match this regex.
 */
const LINUX_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export function validateLinuxUsername(raw: string): string {
  if (typeof raw !== "string") {
    throw new Error("runAs must be a string");
  }
  const v = raw.trim();
  if (v.length === 0) {
    throw new Error("runAs must not be empty");
  }
  if (!LINUX_USERNAME_RE.test(v)) {
    throw new Error(
      "runAs must be a valid Linux username: lowercase letter or underscore first, " +
        "then [a-z0-9_-], max 32 chars",
    );
  }
  return v;
}

/**
 * Build the command line that executes `command` as another Linux user via sudo,
 * non-interactively. The runAs argument MUST already be validated via
 * {@link validateLinuxUsername}.
 *
 * Form:
 *     sudo -S -p '' -iu <runAs> -- bash -lc <quoted command>
 *
 *  -S         read password from stdin (we pipe it in if provided)
 *  -p ''      empty prompt so nothing leaks to stderr
 *  -i         run as login shell of the target user
 *  -u <name>  target user
 *  --         end of sudo options
 *  bash -lc   login bash, single command string
 */
export function buildSudoRunAsCommand(runAs: string, command: string): string {
  // Defence in depth: re-validate, even if caller already did.
  const validated = validateLinuxUsername(runAs);
  return `sudo -S -p '' -iu ${validated} -- bash -lc ${shellQuote(command)}`;
}

/**
 * Build a `cd <cwd> && <command>` wrapper.
 * Both inputs are properly quoted; multi-line commands and shell metacharacters in
 * cwd are handled safely.
 */
export function buildCdWrappedCommand(cwd: string, command: string): string {
  return `cd ${shellQuote(cwd)} && ${command}`;
}
