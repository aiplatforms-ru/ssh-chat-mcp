# Security policy

## Threat model

`ssh-chat-mcp` is designed so that **no connection data ever lives outside the
running MCP process**:

- No hosts, ports, usernames, passwords, private keys, passphrases, or paths
  in the MCP server configuration.
- No environment variables consulted for secrets.
- No disk persistence of credentials, known_hosts, or session state.
- Connections live in an in-memory `Map`; on `disconnect` (or process exit)
  the credential strings are overwritten with `[REDACTED]` and the entry is
  dropped from the map.
- `stdout` is reserved for MCP JSON-RPC. Diagnostics go to `stderr` only and
  are passed through redaction before being printed.

## What this server does **not** protect against

- **Untrusted host keys.** Host-key checking is disabled because TOFU
  pinning would require disk persistence. The calling user/client is
  responsible for trusting the host before issuing `connect`.
- **Malicious commands.** There is no built-in blacklist for destructive
  commands (`rm -rf /`, `mkfs`, etc.). This is deliberate — the MCP is
  zero-config and the *MCP client / human approval layer* must approve
  dangerous commands.
- **Chat history leakage.** Passing a password or private key to the model
  means that secret will be visible in your chat client's transcript, in
  the model provider's logs (if any), and possibly in any sharing/export
  feature. Rotate credentials after use if this concerns you.
- **Local malware.** If someone is reading your process memory, this MCP
  cannot help you.

## Defence-in-depth measures included

| Surface                | Mitigation                                                     |
|------------------------|----------------------------------------------------------------|
| Tool input             | `zod` schemas; `runAs` must match `^[a-z_][a-z0-9_-]{0,31}$`.  |
| Shell injection        | POSIX single-quote escaping in `shellQuote.ts` for `cwd` and `command`. |
| sudo password          | Piped via stdin; never on the command line, never logged.      |
| Tool output            | Recursive redaction of `password` / `privateKey` / `passphrase` / `sudoPassword` / `token` / `Authorization: Bearer ...` / PEM blocks. |
| Error messages         | All thrown errors pass through `redactError` before surfacing. |
| stdout                 | Never written to from application code (would corrupt JSON-RPC). |

## Reporting a vulnerability

Please open a **private** GitHub Security Advisory on the repository, or
email the maintainer listed in `package.json`. Do not file public issues
for security problems.

We aim to acknowledge reports within 7 days.
