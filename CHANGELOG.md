# Changelog

All notable changes to `ssh-chat-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-12

### Added
- Long-running command job tools: `exec_start`, `exec_as_start`, `exec_status`,
  `exec_jobs`, `exec_cancel`, and `exec_remove`.
- `diagnose` tool for distinguishing local MCP server health, missing
  connections, SSH errors, and unresponsive SSH probes.
- Rolling in-memory stdout/stderr buffers for command jobs with offset-based
  incremental reads.

### Changed
- SSH client errors are now handled after connection setup so remote reboots or
  network drops do not crash the MCP stdio transport.
- A single `SIGINT` cancels active exec calls/jobs; a second quick `SIGINT`
  exits the MCP server.
- `disconnect` is idempotent when the connection is already gone.

## [0.1.0] - 2026-05-11

### Added
- Initial release.
- MCP stdio server with zero-config SSH/SFTP tools.
- Tools: `connect`, `disconnect`, `list_connections`, `exec`, `exec_as`,
  `upload_file`, `upload_directory`, `download_file`, `read_remote_file`,
  `write_remote_file`.
- Password and private-key authentication, non-standard SSH ports.
- `exec_as` via `sudo -S -p '' -iu <user> -- bash -lc <cmd>` with strict
  username validation.
- Secret redaction layer for tool outputs and error messages.
- Tests for redaction, shell quoting, runAs validation, and error formatting.
