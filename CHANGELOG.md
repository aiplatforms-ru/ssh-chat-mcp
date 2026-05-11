# Changelog

All notable changes to `ssh-chat-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
