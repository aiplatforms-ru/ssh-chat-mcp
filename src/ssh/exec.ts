/**
 * SSH command execution helpers.
 *
 * Provides `execCommand` (plain exec, optionally cwd-wrapped) and `execAsUser`
 * (sudo -iu non-interactive).
 *
 * All flavours:
 *  - Stream stdout/stderr into in-memory buffers.
 *  - Apply a wall-clock timeout that kills the channel.
 *  - Capture exitCode and signal.
 *  - Redact known secret patterns before returning.
 */

import type { Client as SshClient, ClientChannel } from "ssh2";
import type { ConnectionDescriptor, ExecResult } from "../types.js";
import { redactString } from "../security/redact.js";
import {
  buildCdWrappedCommand,
  buildSudoRunAsCommand,
  validateLinuxUsername,
} from "../security/shellQuote.js";

interface RunArgs {
  client: SshClient;
  command: string;
  timeoutMs: number;
  stdin?: string;
}

/**
 * Low-level runner: exec a command string on a connected SSH client and collect output.
 * Internal — callers should use `execCommand` or `execAsUser` instead.
 */
async function runRaw({ client, command, timeoutMs, stdin }: RunArgs): Promise<ExecResult> {
  return await new Promise<ExecResult>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let settled = false;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const cleanup = (stream?: ClientChannel) => {
      if (timer) clearTimeout(timer);
      if (stream) {
        try {
          stream.removeAllListeners();
        } catch {
          /* ignore */
        }
      }
    };

    client.exec(command, { pty: false }, (err, stream) => {
      if (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        try {
          stream.signal("KILL");
        } catch {
          /* ignore */
        }
        try {
          stream.close();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      // Don't keep the event loop alive just because of this timer.
      timer.unref?.();

      stream.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      let exitCode: number | null = null;
      let signal: string | null = null;

      stream.on("exit", (code: number | null, sig?: string | null) => {
        exitCode = code;
        signal = sig ?? null;
      });

      stream.on("close", () => {
        if (settled) return;
        settled = true;
        cleanup(stream);
        const stdout = redactString(Buffer.concat(stdoutChunks).toString("utf8"));
        const stderr = redactString(Buffer.concat(stderrChunks).toString("utf8"));
        if (timedOut) {
          resolve({
            stdout,
            stderr,
            exitCode,
            signal: signal ?? "KILL",
            timedOut: true,
          });
        } else {
          resolve({ stdout, stderr, exitCode, signal, timedOut: false });
        }
      });

      stream.on("error", (e: Error) => {
        if (settled) return;
        settled = true;
        cleanup(stream);
        reject(e);
      });

      if (stdin && stdin.length > 0) {
        try {
          stream.write(stdin);
          if (!stdin.endsWith("\n")) stream.write("\n");
        } catch {
          /* ignore */
        }
      }
      try {
        stream.end();
      } catch {
        /* ignore */
      }
    });
  });
}

export interface ExecCommandOpts {
  conn: ConnectionDescriptor;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
}

/**
 * Execute an arbitrary shell command on the remote host.
 *
 * If `cwd` is provided, the command is wrapped as `cd <quoted cwd> && <command>`
 * so the user-supplied command runs in that directory.
 */
export async function execCommand(opts: ExecCommandOpts): Promise<ExecResult> {
  const { conn, command, cwd, timeoutMs = 120_000, stdin } = opts;
  if (!command || typeof command !== "string") {
    throw new Error("command is required");
  }
  const finalCommand = cwd && cwd.length > 0 ? buildCdWrappedCommand(cwd, command) : command;
  return runRaw({
    client: conn.client,
    command: finalCommand,
    timeoutMs,
    stdin,
  });
}

export interface ExecAsOpts {
  conn: ConnectionDescriptor;
  runAs: string;
  command: string;
  sudoPassword?: string;
  timeoutMs?: number;
}

/**
 * Execute a command on the remote host as another Linux user via sudo.
 *
 * Non-interactive: uses `sudo -S -p '' -iu <runAs> -- bash -lc <quoted command>`.
 * If `sudoPassword` is provided it's piped to stdin (with a trailing newline),
 * so it never appears on a command line or in logs.
 */
export async function execAsUser(opts: ExecAsOpts): Promise<ExecResult> {
  const { conn, runAs, command, sudoPassword, timeoutMs = 120_000 } = opts;
  if (!command || typeof command !== "string") {
    throw new Error("command is required");
  }
  // Validate up front so we never even build a sudo line with junk.
  validateLinuxUsername(runAs);
  const sudoLine = buildSudoRunAsCommand(runAs, command);
  return runRaw({
    client: conn.client,
    command: sudoLine,
    timeoutMs,
    stdin: sudoPassword,
  });
}
