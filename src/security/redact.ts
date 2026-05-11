/**
 * Redaction utilities.
 *
 * Goals:
 *  - Never let raw secrets leak into tool output, error messages, or stderr logs.
 *  - Redact known sensitive field names (password, passphrase, privateKey, sudoPassword).
 *  - Redact common secret patterns in free-form text (PEM blocks, bearer tokens,
 *    `password=...`, `token=...`, etc.).
 *
 * This module is intentionally conservative: false positives (over-redaction) are
 * preferred over leaking real secrets.
 */

export const REDACTED = "[REDACTED]";

/** Field names whose values must always be redacted in serialised objects. */
const SENSITIVE_KEYS = new Set([
  "password",
  "passphrase",
  "privatekey",
  "private_key",
  "sudopassword",
  "sudo_password",
  "authorization",
  "auth",
  "secret",
  "token",
  "apikey",
  "api_key",
  "access_token",
  "refresh_token",
]);

/**
 * Replace PEM-encoded private key blocks (RSA, OPENSSH, EC, DSA, etc.)
 * with a single redaction marker.
 */
function redactPemBlocks(input: string): string {
  return input.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    `-----BEGIN PRIVATE KEY-----\n${REDACTED}\n-----END PRIVATE KEY-----`,
  );
}

/**
 * Redact common `key=value` style secrets and HTTP auth headers in free-form text.
 *
 * Matches things like:
 *   password=hunter2
 *   PASSWORD: hunter2
 *   token="abc.def"
 *   Authorization: Bearer eyJhbGciOi...
 *   x-api-key: foo
 */
function redactKeyValueSecrets(input: string): string {
  let out = input;

  // Authorization: Bearer <token>
  out = out.replace(
    /(Authorization)\s*[:=]\s*(Bearer|Basic|Token)\s+[^\s"']+/gi,
    `$1: $2 ${REDACTED}`,
  );

  // *_api_key / x-api-key / api-key / apiKey etc.
  // NB: we use a lookbehind that disallows alphanumerics so we don't match in
  // arbitrary identifiers, but we DO want to catch leading underscores like
  // `MY_API_KEY=foo`. So we allow any non-alphanumeric (or start-of-line).
  out = out.replace(
    /(^|[^A-Za-z0-9])([A-Za-z0-9_-]*?(?:x[-_]?api[-_]?key|api[-_]?key))\s*[:=]\s*["']?[^\s"',;&]+["']?/gi,
    `$1$2=${REDACTED}`,
  );

  // *_password / password / passphrase / sudoPassword / secret / token / access_token / refresh_token
  out = out.replace(
    /(^|[^A-Za-z0-9])([A-Za-z0-9_-]*?(?:passwords?|passphrase|sudo[-_]?password|secret|tokens?|access[-_]?token|refresh[-_]?token))\s*[:=]\s*["']?[^\s"',;&]+["']?/gi,
    `$1$2=${REDACTED}`,
  );

  return out;
}

/**
 * Redact secret patterns inside an arbitrary string (stdout, stderr, error message, etc.).
 */
export function redactString(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  let out = redactPemBlocks(input);
  out = redactKeyValueSecrets(out);
  return out;
}

/**
 * Best-effort: clear sensitive string fields from a plain object in place.
 * Used to scrub credentials out of an in-memory connection descriptor after disconnect.
 */
export function clearSecrets<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): void {
  for (const k of keys) {
    if (k in obj) {
      const v = (obj as Record<string, unknown>)[k];
      if (typeof v === "string") {
        // Overwrite the underlying string slot. We cannot truly zero-out a JS string
        // (immutable), but we can drop the reference and replace with a sentinel.
        (obj as Record<string, unknown>)[k] = REDACTED;
      } else {
        (obj as Record<string, unknown>)[k] = undefined;
      }
    }
  }
}

/**
 * Deep-redact a value for safe inclusion in tool output:
 *  - Sensitive keys -> [REDACTED]
 *  - Strings -> pattern-redacted
 *  - Buffers -> "[Buffer N bytes]"
 *  - Arrays / objects -> recursed
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value;
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }

  // Functions, symbols, etc.
  return "[unserialisable]";
}

/**
 * Produce a safe error message string: takes any thrown value, extracts a message,
 * and runs it through redaction. Never includes raw stack traces.
 */
export function redactError(err: unknown): string {
  let msg: string;
  if (err instanceof Error) {
    msg = err.message || err.name || "Error";
  } else if (typeof err === "string") {
    msg = err;
  } else if (err === undefined) {
    msg = "undefined error";
  } else if (err === null) {
    msg = "null error";
  } else {
    try {
      const j = JSON.stringify(err);
      msg = typeof j === "string" ? j : String(err);
    } catch {
      msg = String(err);
    }
  }
  return redactString(msg);
}
