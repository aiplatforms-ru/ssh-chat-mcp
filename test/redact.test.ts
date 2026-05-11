import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REDACTED,
  redactString,
  redactValue,
  redactError,
  clearSecrets,
} from "../src/security/redact.ts";

test("redactString masks password= patterns", () => {
  const input = "DB_URL=postgres://u:hunter2@host/db password=topsecret token=abc.def";
  const out = redactString(input);
  assert.ok(!out.includes("topsecret"), "password value must be removed");
  assert.ok(!out.includes("abc.def"), "token value must be removed");
  assert.ok(out.includes(REDACTED));
});

test("redactString masks Authorization Bearer", () => {
  const input = "Authorization: Bearer eyJabcDEF.someJWT";
  const out = redactString(input);
  assert.ok(!out.includes("eyJabcDEF.someJWT"));
  assert.ok(out.includes(REDACTED));
});

test("redactString collapses PEM private key blocks", () => {
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nABCDEF\nGHIJKL\n-----END RSA PRIVATE KEY-----";
  const out = redactString(pem);
  assert.ok(!out.includes("ABCDEF"), "PEM body must be removed");
  assert.ok(out.includes(REDACTED));
  assert.ok(out.includes("BEGIN PRIVATE KEY") && out.includes("END PRIVATE KEY"));
});

test("redactValue redacts sensitive keys recursively", () => {
  const obj = {
    connectionName: "temp1",
    host: "1.2.3.4",
    password: "hunter2",
    nested: {
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----",
      sudoPassword: "anothersecret",
      stdout: "Authorization: Bearer foo.bar",
    },
    list: [{ token: "abc" }, "password=plain"],
  };
  const safe = redactValue(obj) as Record<string, unknown>;
  const json = JSON.stringify(safe);
  assert.ok(!json.includes("hunter2"));
  assert.ok(!json.includes("anothersecret"));
  assert.ok(!json.includes("foo.bar"));
  assert.ok(!json.includes("\"token\":\"abc\""));
  assert.ok(!json.includes("password=plain"));
  assert.equal((safe.nested as Record<string, unknown>).privateKey, REDACTED);
  assert.equal(safe.password, REDACTED);
});

test("redactError extracts and redacts message", () => {
  const e = new Error("auth failed: password=hunter2");
  const msg = redactError(e);
  assert.ok(!msg.includes("hunter2"));
  assert.ok(msg.includes(REDACTED));
});

test("redactError handles non-Error throwables", () => {
  assert.equal(typeof redactError("boom"), "string");
  assert.equal(typeof redactError({ x: 1 }), "string");
  assert.equal(typeof redactError(undefined), "string");
});

test("clearSecrets wipes named string fields", () => {
  const obj: Record<string, unknown> = {
    password: "hunter2",
    passphrase: "phrase",
    other: "kept",
  };
  clearSecrets(obj, ["password", "passphrase"]);
  assert.equal(obj.password, REDACTED);
  assert.equal(obj.passphrase, REDACTED);
  assert.equal(obj.other, "kept");
});
