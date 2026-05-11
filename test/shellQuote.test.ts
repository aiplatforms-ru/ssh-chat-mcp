import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shellQuote,
  validateLinuxUsername,
  buildSudoRunAsCommand,
  buildCdWrappedCommand,
} from "../src/security/shellQuote.ts";

test("shellQuote wraps plain strings in single quotes", () => {
  assert.equal(shellQuote("hello"), "'hello'");
  assert.equal(shellQuote(""), "''");
});

test("shellQuote escapes embedded single quotes", () => {
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test("shellQuote handles shell metacharacters safely", () => {
  const tricky = `; rm -rf / $(whoami) \`id\` && echo $HOME`;
  const q = shellQuote(tricky);
  assert.ok(q.startsWith("'") && q.endsWith("'"));
  // None of the metas should appear unquoted; whole payload sits between the outer quotes.
  assert.ok(q.includes("rm -rf /"));
});

test("shellQuote handles newlines", () => {
  const v = "line1\nline2";
  const q = shellQuote(v);
  assert.equal(q, "'line1\nline2'");
});

test("validateLinuxUsername accepts typical usernames", () => {
  for (const u of ["appuser", "deploy", "_svc", "www-data", "u1", "a_b-c"]) {
    assert.equal(validateLinuxUsername(u), u);
  }
});

test("validateLinuxUsername rejects shell injection attempts", () => {
  const bad = [
    "root; rm -rf /",
    "user`id`",
    "$(whoami)",
    "user with space",
    "Root",         // uppercase rejected by our conservative rule
    "1user",        // can't start with digit
    "-user",        // can't start with dash
    "",             // empty
    "u".repeat(64), // too long
    "a/b",
    "a|b",
    "a&b",
    "a\nb",
  ];
  for (const u of bad) {
    assert.throws(() => validateLinuxUsername(u), `should reject: ${JSON.stringify(u)}`);
  }
});

test("buildSudoRunAsCommand produces a safe sudo invocation", () => {
  const cmd = buildSudoRunAsCommand("appuser", "echo hi; rm -rf /tmp/foo");
  // Username appears unquoted (we validated it).
  assert.ok(cmd.startsWith("sudo -S -p '' -iu appuser -- bash -lc "));
  // The whole command is wrapped in single quotes.
  assert.ok(cmd.endsWith("'echo hi; rm -rf /tmp/foo'"));
});

test("buildSudoRunAsCommand re-validates runAs", () => {
  assert.throws(() => buildSudoRunAsCommand("root; evil", "true"));
});

test("buildCdWrappedCommand quotes cwd", () => {
  const wrapped = buildCdWrappedCommand("/tmp/with space/'q", "ls -la");
  assert.ok(wrapped.startsWith("cd '/tmp/with space/'\\''q'"));
  assert.ok(wrapped.endsWith(" && ls -la"));
});
