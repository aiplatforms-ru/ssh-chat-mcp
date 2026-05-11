/**
 * End-to-end-ish checks that error messages and serialised tool results
 * never contain raw secrets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { redactError, redactValue } from "../src/security/redact.ts";

test("no secret values appear in formatted error message", () => {
  const password = "supersecretP@ss123!";
  const err = new Error(`SSH auth failed for user=admin password=${password}`);
  const formatted = `ERROR: ${redactError(err)}`;
  assert.ok(!formatted.includes(password));
});

test("no secret values appear in serialised tool result", () => {
  const privateKey =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJB...\n-----END RSA PRIVATE KEY-----";
  const password = "hunter2";
  const sudoPassword = "sudoSecret";
  const result = {
    ok: true,
    connection: {
      connectionName: "temp1",
      host: "1.2.3.4",
      username: "deploy",
      password,
      privateKey,
      sudoPassword,
    },
    stdout: `Authorization: Bearer abc.def.ghi\nDB_PASSWORD=${password}\n`,
  };
  const safe = redactValue(result);
  const serialised = JSON.stringify(safe);
  for (const leak of [password, privateKey, sudoPassword, "abc.def.ghi", "MIIBOgIBAAJB"]) {
    assert.ok(!serialised.includes(leak), `secret leaked: ${leak.slice(0, 16)}…`);
  }
});

test("non-Error throwables are still redacted safely", () => {
  const msg = redactError({ message: "boom token=abc.def" });
  assert.ok(!msg.includes("abc.def"));
});
