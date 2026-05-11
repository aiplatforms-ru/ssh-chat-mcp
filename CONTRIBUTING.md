# Contributing to ssh-chat-mcp

Thanks for your interest!

## Ground rules

1. **Zero-config is non-negotiable.** Any PR that introduces a config file,
   env variable, dotfile, or hardcoded host/path will be rejected. All
   connection data must come from tool arguments at runtime.
2. **Never write to stdout.** stdout is owned by MCP JSON-RPC. Use
   `console.error` (and only for genuinely useful diagnostics).
3. **All output flows through redaction.** Any new tool must serialise its
   result via `redactValue` and surface errors via `redactError`.
4. **Strict shell quoting.** Any new code path that builds a remote command
   line must use `shellQuote` / `buildSudoRunAsCommand` / `buildCdWrappedCommand`
   from `src/security/shellQuote.ts`. Never string-concatenate user input
   into a shell line.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The compiled server lands in `build/index.js` with a shebang and is
executable as `node build/index.js`.

## Adding a tool

1. Define the input as a `z.object`-shape inside `registerTool`. Each field
   needs a `.describe(...)` so the model sees clear semantics.
2. Implement the work in `src/ssh/...` (one module per concern).
3. Wrap the implementation with `toolHandler(...)` so the result is
   redacted and any thrown error surfaces as `isError: true`.
4. Add at least one test covering the input validation / redaction surface.

## Tests

We use Node's built-in `node:test` runner with `tsx` as the loader. Place
tests in `test/*.test.ts`. Avoid tests that require a real SSH server in CI.

## Commit style

Imperative present tense (`add upload_directory exclude support`), one
logical change per commit. Reference issues with `Fixes #N` where relevant.
