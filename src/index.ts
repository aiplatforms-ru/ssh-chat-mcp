/**
 * ssh-chat-mcp: zero-config SSH/SFTP MCP server (stdio transport).
 *
 * Important constraints:
 *  - Never write to stdout: it carries MCP JSON-RPC. Use console.error for diagnostics.
 *  - No host/port/user/password/path is hardcoded. Everything comes from tool args.
 *  - Credentials live only in memory and are wiped on disconnect / process exit.
 *  - All tool outputs and error messages pass through redaction.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ConnectionManager } from "./ssh/connectionManager.js";
import { execCommand, execAsUser } from "./ssh/exec.js";
import {
  uploadFile,
  uploadDirectory,
  downloadFile,
  readRemoteFile,
  writeRemoteFile,
} from "./ssh/sftp.js";
import { redactError, redactValue } from "./security/redact.js";

const SERVER_NAME = "ssh-chat-mcp";
const SERVER_VERSION = "0.1.0";

const manager = new ConnectionManager();

/** Wrap a tool implementation so any thrown error is redacted and surfaced as isError. */
function toolHandler<TArgs>(
  fn: (args: TArgs) => Promise<unknown>,
): (args: TArgs) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}> {
  return async (args: TArgs) => {
    try {
      const result = await fn(args);
      const safe = redactValue(result);
      return {
        content: [{ type: "text", text: JSON.stringify(safe, null, 2) }],
      };
    } catch (err) {
      const msg = redactError(err);
      return {
        content: [{ type: "text", text: `ERROR: ${msg}` }],
        isError: true,
      };
    }
  };
}

async function main(): Promise<void> {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // -------------------------------------------------------------------------
  // connect
  // -------------------------------------------------------------------------
  server.registerTool(
    "connect",
    {
      title: "Open SSH connection",
      description:
        "Open a temporary in-memory SSH connection. Requires host, username, and " +
        "either password OR privateKey (PEM). All credentials are kept in RAM only " +
        "and wiped on disconnect. WARNING: this connects to a real remote host and " +
        "host-key checking is disabled — the calling user is responsible for trust.",
      inputSchema: {
        connectionName: z
          .string()
          .min(1)
          .describe("Caller-chosen handle used to refer to this connection in later tool calls."),
        host: z.string().min(1).describe("Hostname or IP of the SSH server."),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe("SSH port (default 22)."),
        username: z.string().min(1).describe("Remote SSH username."),
        password: z
          .string()
          .optional()
          .describe("Optional password. Never logged or returned."),
        privateKey: z
          .string()
          .optional()
          .describe("Optional PEM-encoded private key. Never logged or returned."),
        passphrase: z
          .string()
          .optional()
          .describe("Optional passphrase for the private key. Never logged or returned."),
        readyTimeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(600_000)
          .optional()
          .describe("How long to wait for the SSH handshake (default 30000)."),
        keepaliveIntervalMs: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional()
          .describe("Keepalive interval in ms (default 10000)."),
      },
    },
    toolHandler(async (args: {
      connectionName: string;
      host: string;
      port?: number;
      username: string;
      password?: string;
      privateKey?: string;
      passphrase?: string;
      readyTimeoutMs?: number;
      keepaliveIntervalMs?: number;
    }) => {
      const info = await manager.connect(args);
      return { ...info, connected: info.status === "connected" };
    }),
  );

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------
  server.registerTool(
    "disconnect",
    {
      title: "Close SSH connection",
      description:
        "Close the named SSH connection and wipe its credentials from memory.",
      inputSchema: {
        connectionName: z.string().min(1),
      },
    },
    toolHandler(async (args: { connectionName: string }) => {
      await manager.disconnect(args.connectionName);
      return { connectionName: args.connectionName, disconnected: true };
    }),
  );

  // -------------------------------------------------------------------------
  // list_connections
  // -------------------------------------------------------------------------
  server.registerTool(
    "list_connections",
    {
      title: "List active SSH connections",
      description:
        "List currently registered SSH connections. Returns only non-sensitive metadata " +
        "(connectionName, host, port, username, connectedAt, status).",
      inputSchema: {},
    },
    toolHandler(async () => {
      return { connections: manager.list() };
    }),
  );

  // -------------------------------------------------------------------------
  // exec
  // -------------------------------------------------------------------------
  server.registerTool(
    "exec",
    {
      title: "Run a shell command on the remote host",
      description:
        "Execute a shell command over SSH on the named connection. WARNING: this runs " +
        "real commands on a real remote machine — destructive operations are NOT blocked " +
        "by this server. The MCP client / approval layer is responsible for confirming " +
        "dangerous commands with the user.",
      inputSchema: {
        connectionName: z.string().min(1),
        command: z.string().min(1).describe("Shell command to execute on the remote host."),
        cwd: z
          .string()
          .optional()
          .describe("Optional remote working directory. Wrapped as `cd <cwd> && <command>`."),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(24 * 60 * 60_000)
          .optional()
          .describe("Wall-clock timeout in ms (default 120000)."),
        stdin: z.string().optional().describe("Optional stdin to feed to the command."),
      },
    },
    toolHandler(async (args: {
      connectionName: string;
      command: string;
      cwd?: string;
      timeoutMs?: number;
      stdin?: string;
    }) => {
      const conn = manager.get(args.connectionName);
      return await execCommand({
        conn,
        command: args.command,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        stdin: args.stdin,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // exec_as
  // -------------------------------------------------------------------------
  server.registerTool(
    "exec_as",
    {
      title: "Run a command as another Linux user (sudo)",
      description:
        "Run a command non-interactively as another Linux user via " +
        "`sudo -S -p '' -iu <runAs> -- bash -lc <command>`. The optional sudoPassword " +
        "is piped to stdin and is never returned or logged. runAs is strictly validated " +
        "as a Linux username. WARNING: this performs privileged actions on the remote host.",
      inputSchema: {
        connectionName: z.string().min(1),
        runAs: z
          .string()
          .min(1)
          .max(32)
          .describe("Target Linux username, e.g. 'appuser'. Strictly validated."),
        command: z.string().min(1).describe("Command to run as the target user."),
        sudoPassword: z
          .string()
          .optional()
          .describe("Optional sudo password. Piped via stdin; never logged or returned."),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(24 * 60 * 60_000)
          .optional(),
      },
    },
    toolHandler(async (args: {
      connectionName: string;
      runAs: string;
      command: string;
      sudoPassword?: string;
      timeoutMs?: number;
    }) => {
      const conn = manager.get(args.connectionName);
      return await execAsUser({
        conn,
        runAs: args.runAs,
        command: args.command,
        sudoPassword: args.sudoPassword,
        timeoutMs: args.timeoutMs,
      });
    }),
  );

  // -------------------------------------------------------------------------
  // upload_file
  // -------------------------------------------------------------------------
  server.registerTool(
    "upload_file",
    {
      title: "Upload a local file to the remote host (SFTP)",
      description:
        "Upload a single local file to the remote host via SFTP. localPath and " +
        "remotePath are taken from arguments only — no paths are hardcoded.",
      inputSchema: {
        connectionName: z.string().min(1),
        localPath: z.string().min(1).describe("Absolute or relative local file path."),
        remotePath: z.string().min(1).describe("Absolute remote file path."),
        mode: z
          .number()
          .int()
          .min(0)
          .max(0o7777)
          .optional()
          .describe("Optional POSIX mode bits, e.g. 420 = 0o644."),
        mkdirParents: z
          .boolean()
          .optional()
          .describe("If true, create remote parent directories as needed."),
      },
    },
    toolHandler(async (args: {
      connectionName: string;
      localPath: string;
      remotePath: string;
      mode?: number;
      mkdirParents?: boolean;
    }) => {
      const conn = manager.get(args.connectionName);
      const res = await uploadFile({ conn, ...args });
      return {
        ok: true,
        localPath: args.localPath,
        remotePath: args.remotePath,
        bytesUploaded: res.bytesUploaded,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // upload_directory
  // -------------------------------------------------------------------------
  server.registerTool(
    "upload_directory",
    {
      title: "Recursively upload a local directory (SFTP)",
      description:
        "Recursively upload a local directory tree to the remote host via SFTP. " +
        "Excludes are caller-supplied (no project dirs hardcoded). Symlinks are not " +
        "followed unless explicitly requested.",
      inputSchema: {
        connectionName: z.string().min(1),
        localPath: z.string().min(1),
        remotePath: z.string().min(1),
        mkdirParents: z.boolean().optional(),
        followSymlinks: z.boolean().optional(),
        exclude: z
          .array(z.string())
          .optional()
          .describe("Basenames to skip (e.g. ['.git','node_modules'])."),
      },
    },
    toolHandler(async (args: {
      connectionName: string;
      localPath: string;
      remotePath: string;
      mkdirParents?: boolean;
      followSymlinks?: boolean;
      exclude?: string[];
    }) => {
      const conn = manager.get(args.connectionName);
      const res = await uploadDirectory({ conn, ...args });
      return {
        ok: true,
        localPath: args.localPath,
        remotePath: args.remotePath,
        ...res,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // download_file
  // -------------------------------------------------------------------------
  server.registerTool(
    "download_file",
    {
      title: "Download a remote file to local disk (SFTP)",
      description:
        "Download a remote file to the local filesystem via SFTP. " +
        "File content is not included in the tool response; only the byte count.",
      inputSchema: {
        connectionName: z.string().min(1),
        remotePath: z.string().min(1),
        localPath: z.string().min(1),
        mkdirParents: z.boolean().optional(),
      },
    },
    toolHandler(async (args: {
      connectionName: string;
      remotePath: string;
      localPath: string;
      mkdirParents?: boolean;
    }) => {
      const conn = manager.get(args.connectionName);
      const res = await downloadFile({ conn, ...args });
      return {
        ok: true,
        remotePath: args.remotePath,
        localPath: args.localPath,
        bytesDownloaded: res.bytesDownloaded,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // read_remote_file
  // -------------------------------------------------------------------------
  server.registerTool(
    "read_remote_file",
    {
      title: "Read a remote file as text (SFTP)",
      description:
        "Read up to maxBytes of a remote file as UTF-8 text. Content is " +
        "redacted for known secret patterns before being returned.",
      inputSchema: {
        connectionName: z.string().min(1),
        remotePath: z.string().min(1),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(10_000_000)
          .optional()
          .describe("Maximum bytes to read (default 200000, hard cap 10000000)."),
      },
    },
    toolHandler(async (args: {
      connectionName: string;
      remotePath: string;
      maxBytes?: number;
    }) => {
      const conn = manager.get(args.connectionName);
      return await readRemoteFile({ conn, ...args });
    }),
  );

  // -------------------------------------------------------------------------
  // write_remote_file
  // -------------------------------------------------------------------------
  server.registerTool(
    "write_remote_file",
    {
      title: "Write a remote file (SFTP)",
      description:
        "Write a UTF-8 text payload to a remote file via SFTP. Useful for staging " +
        "config files (e.g. into /tmp) which a subsequent `exec` can move into place " +
        "with sudo mv / tee.",
      inputSchema: {
        connectionName: z.string().min(1),
        remotePath: z.string().min(1),
        content: z.string(),
        mode: z.number().int().min(0).max(0o7777).optional(),
        mkdirParents: z.boolean().optional(),
      },
    },
    toolHandler(async (args: {
      connectionName: string;
      remotePath: string;
      content: string;
      mode?: number;
      mkdirParents?: boolean;
    }) => {
      const conn = manager.get(args.connectionName);
      const res = await writeRemoteFile({ conn, ...args });
      return {
        ok: true,
        remotePath: args.remotePath,
        bytesWritten: res.bytesWritten,
      };
    }),
  );

  // -------------------------------------------------------------------------
  // transport
  // -------------------------------------------------------------------------
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (signal: string) => {
    try {
      await manager.disconnectAll();
    } catch (err) {
      console.error(`[${SERVER_NAME}] cleanup error on ${signal}:`, redactError(err));
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(`[${SERVER_NAME}] fatal:`, redactError(err));
  process.exit(1);
});
