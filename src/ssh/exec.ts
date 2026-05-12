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
import type {
  ConnectionDescriptor,
  ExecJobPublicInfo,
  ExecJobStatus,
  ExecResult,
} from "../types.js";
import { redactError, redactString } from "../security/redact.js";
import {
  buildCdWrappedCommand,
  buildSudoRunAsCommand,
  shellQuote,
  validateLinuxUsername,
} from "../security/shellQuote.js";

const activeExecChannels = new Set<ClientChannel>();
const JOB_PID_MARKER = "__SSH_CHAT_MCP_JOB_PID__:";

export function abortActiveExecs(signal = "TERM"): number {
  let count = 0;
  for (const stream of activeExecChannels) {
    count += 1;
    try {
      stream.signal(signal);
    } catch {
      /* ignore */
    }
    try {
      stream.close();
    } catch {
      /* ignore */
    }
  }
  return count;
}

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
        activeExecChannels.delete(stream);
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
          stream.signal("TERM");
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
      activeExecChannels.add(stream);

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

class RollingBuffer {
  private chunks: Buffer[] = [];
  private bufferedBytes = 0;
  totalBytes = 0;
  droppedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    if (buf.length === 0) return;
    this.chunks.push(buf);
    this.bufferedBytes += buf.length;
    this.totalBytes += buf.length;

    while (this.bufferedBytes > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      const overflow = this.bufferedBytes - this.maxBytes;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.bufferedBytes -= first.length;
        this.droppedBytes += first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.bufferedBytes -= overflow;
        this.droppedBytes += overflow;
      }
    }
  }

  read(offset: number | undefined, maxBytes: number): {
    text: string;
    startOffset: number;
    nextOffset: number;
    totalBytes: number;
    truncatedBefore: boolean;
  } {
    const requested = Math.max(0, offset ?? this.droppedBytes);
    const startOffset = Math.max(requested, this.droppedBytes);
    const all = Buffer.concat(this.chunks);
    const startInBuffer = Math.max(0, startOffset - this.droppedBytes);
    const endInBuffer = Math.min(all.length, startInBuffer + maxBytes);
    const slice = all.subarray(startInBuffer, endInBuffer);
    return {
      text: redactString(slice.toString("utf8")),
      startOffset,
      nextOffset: startOffset + slice.length,
      totalBytes: this.totalBytes,
      truncatedBefore: requested < this.droppedBytes,
    };
  }
}

interface ExecJob {
  jobId: string;
  connectionName: string;
  command: string;
  cwd?: string;
  startedAt: string;
  finishedAt?: string;
  status: ExecJobStatus;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  remotePid?: number;
  client: SshClient;
  channel?: ClientChannel;
  stdout: RollingBuffer;
  stderr: RollingBuffer;
  stderrRemainder: string;
  timeout?: NodeJS.Timeout;
  error?: string;
}

export interface ExecStartOpts {
  conn: ConnectionDescriptor;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
  maxBufferBytes?: number;
}

export interface ExecAsStartOpts extends ExecStartOpts {
  runAs: string;
  sudoPassword?: string;
}

export interface ExecStatusOpts {
  jobId: string;
  stdoutOffset?: number;
  stderrOffset?: number;
  maxBytes?: number;
}

type ExecStatusResult = ExecJobPublicInfo & {
  stdout: ReturnType<RollingBuffer["read"]>;
  stderr: ReturnType<RollingBuffer["read"]>;
};

export class ExecJobManager {
  private readonly jobs = new Map<string, ExecJob>();

  async start(opts: ExecStartOpts): Promise<ExecStatusResult> {
    const { conn, command, cwd, timeoutMs = 0, stdin, maxBufferBytes = 1_000_000 } = opts;
    if (!command || typeof command !== "string") {
      throw new Error("command is required");
    }
    const finalCommand = cwd && cwd.length > 0 ? buildCdWrappedCommand(cwd, command) : command;
    return await this.startTracked({
      conn,
      displayCommand: command,
      finalCommand,
      cwd,
      timeoutMs,
      stdin,
      maxBufferBytes,
    });
  }

  async startAs(opts: ExecAsStartOpts): Promise<ExecStatusResult> {
    const {
      conn,
      runAs,
      command,
      cwd,
      timeoutMs = 0,
      sudoPassword,
      maxBufferBytes = 1_000_000,
    } = opts;
    if (!command || typeof command !== "string") {
      throw new Error("command is required");
    }
    validateLinuxUsername(runAs);
    const cwdCommand = cwd && cwd.length > 0 ? buildCdWrappedCommand(cwd, command) : command;
    const sudoLine = buildSudoRunAsCommand(runAs, cwdCommand);
    return await this.startTracked({
      conn,
      displayCommand: command,
      finalCommand: sudoLine,
      cwd,
      timeoutMs,
      stdin: sudoPassword,
      maxBufferBytes,
    });
  }

  status(opts: ExecStatusOpts): ExecStatusResult {
    const job = this.getJob(opts.jobId);
    return this.formatStatus(job, opts);
  }

  list(connectionName?: string): ExecJobPublicInfo[] {
    return [...this.jobs.values()]
      .filter((job) => !connectionName || job.connectionName === connectionName)
      .map((job) => this.publicInfo(job));
  }

  async cancel(jobId: string, signal = "TERM"): Promise<ExecStatusResult> {
    const job = this.getJob(jobId);
    if (this.isFinished(job)) return this.formatStatus(job, { jobId });
    job.status = "cancelled";
    await this.stopRemoteJob(job, signal);
    return this.formatStatus(job, { jobId });
  }

  remove(jobId: string): { jobId: string; removed: boolean } {
    const job = this.jobs.get(jobId);
    if (!job) return { jobId, removed: false };
    if (!this.isFinished(job)) {
      throw new Error(`job ${jobId} is still ${job.status}; cancel it before removing`);
    }
    this.jobs.delete(jobId);
    return { jobId, removed: true };
  }

  async cancelAll(signal = "TERM"): Promise<number> {
    const running = [...this.jobs.values()].filter((job) => !this.isFinished(job));
    await Promise.allSettled(running.map((job) => this.stopRemoteJob(job, signal)));
    for (const job of running) {
      job.status = "cancelled";
    }
    return running.length;
  }

  private async startTracked(opts: {
    conn: ConnectionDescriptor;
    displayCommand: string;
    finalCommand: string;
    cwd?: string;
    timeoutMs: number;
    stdin?: string;
    maxBufferBytes: number;
  }): Promise<ExecStatusResult> {
    const bufferLimit = Math.min(Math.max(opts.maxBufferBytes, 4_096), 50_000_000);
    const job: ExecJob = {
      jobId: this.nextJobId(),
      connectionName: opts.conn.connectionName,
      command: opts.displayCommand,
      cwd: opts.cwd,
      startedAt: new Date().toISOString(),
      status: "starting",
      exitCode: null,
      signal: null,
      timedOut: false,
      client: opts.conn.client,
      stdout: new RollingBuffer(bufferLimit),
      stderr: new RollingBuffer(bufferLimit),
      stderrRemainder: "",
    };
    this.jobs.set(job.jobId, job);

    const trackedCommand = this.buildTrackedCommand(opts.finalCommand);
    await new Promise<void>((resolve, reject) => {
      opts.conn.client.exec(trackedCommand, { pty: false }, (err, stream) => {
        if (err) {
          this.finishJob(job, "error", err);
          reject(err);
          return;
        }

        job.channel = stream;
        job.status = "running";

        if (opts.timeoutMs > 0) {
          job.timeout = setTimeout(() => {
            job.timedOut = true;
            job.status = "timed_out";
            void this.stopRemoteJob(job, "TERM");
          }, opts.timeoutMs);
          job.timeout.unref?.();
        }

        stream.on("data", (chunk: Buffer) => {
          job.stdout.append(chunk);
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          this.handleStderrChunk(job, chunk);
        });
        stream.on("exit", (code: number | null, sig?: string | null) => {
          job.exitCode = code;
          job.signal = sig ?? null;
        });
        stream.on("close", () => {
          this.flushStderrRemainder(job);
          if (job.status === "running" || job.status === "starting") {
            job.status = "exited";
          }
          this.finishJob(job, job.status);
        });
        stream.on("error", (e: Error) => {
          this.finishJob(job, "error", e);
        });

        if (opts.stdin && opts.stdin.length > 0) {
          try {
            stream.write(opts.stdin);
            if (!opts.stdin.endsWith("\n")) stream.write("\n");
          } catch {
            /* ignore */
          }
        }
        try {
          stream.end();
        } catch {
          /* ignore */
        }
        resolve();
      });
    });

    return this.formatStatus(job, { jobId: job.jobId });
  }

  private buildTrackedCommand(command: string): string {
    const inner = [
      "if command -v setsid >/dev/null 2>&1; then",
      `  setsid bash -lc ${shellQuote(command)} &`,
      "else",
      `  bash -lc ${shellQuote(command)} &`,
      "fi",
      "__mcp_pid=$!",
      `printf '${JOB_PID_MARKER}%s\\n' \"$__mcp_pid\" >&2`,
      "wait \"$__mcp_pid\"",
    ].join("\n");
    return `bash -lc ${shellQuote(inner)}`;
  }

  private handleStderrChunk(job: ExecJob, chunk: Buffer): void {
    job.stderrRemainder += chunk.toString("utf8");
    let newline = job.stderrRemainder.indexOf("\n");
    while (newline >= 0) {
      const line = job.stderrRemainder.slice(0, newline + 1);
      job.stderrRemainder = job.stderrRemainder.slice(newline + 1);
      this.handleStderrLine(job, line);
      newline = job.stderrRemainder.indexOf("\n");
    }
  }

  private handleStderrLine(job: ExecJob, line: string): void {
    if (line.startsWith(JOB_PID_MARKER)) {
      const rawPid = line.slice(JOB_PID_MARKER.length).trim();
      const pid = Number.parseInt(rawPid, 10);
      if (Number.isSafeInteger(pid) && pid > 0) {
        job.remotePid = pid;
      }
      return;
    }
    job.stderr.append(line);
  }

  private flushStderrRemainder(job: ExecJob): void {
    if (job.stderrRemainder.length === 0) return;
    this.handleStderrLine(job, job.stderrRemainder);
    job.stderrRemainder = "";
  }

  private async stopRemoteJob(job: ExecJob, signal: string): Promise<void> {
    const cleanSignal = /^[A-Z0-9]+$/.test(signal) ? signal : "TERM";
    if (job.timeout) {
      clearTimeout(job.timeout);
      job.timeout = undefined;
    }

    if (job.remotePid) {
      await this.execBestEffort(
        job.client,
        `kill -${cleanSignal} -${job.remotePid} 2>/dev/null || ` +
          `kill -${cleanSignal} ${job.remotePid} 2>/dev/null || true`,
      );
      if (cleanSignal !== "KILL") {
        setTimeout(() => {
          if (!this.isFinished(job) && job.remotePid) {
            void this.execBestEffort(
              job.client,
              `kill -KILL -${job.remotePid} 2>/dev/null || ` +
                `kill -KILL ${job.remotePid} 2>/dev/null || true`,
            );
          }
        }, 3_000).unref?.();
      }
    }

    if (job.channel) {
      try {
        job.channel.signal(cleanSignal);
      } catch {
        /* ignore */
      }
      try {
        job.channel.close();
      } catch {
        /* ignore */
      }
    }
  }

  private execBestEffort(client: SshClient, command: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        client.exec(command, (err, stream) => {
          if (err) return resolve();
          stream.on("close", () => resolve());
          stream.on("error", () => resolve());
          stream.end();
        });
      } catch {
        resolve();
      }
      setTimeout(resolve, 2_000).unref?.();
    });
  }

  private finishJob(job: ExecJob, status: ExecJobStatus, err?: unknown): void {
    if (job.timeout) {
      clearTimeout(job.timeout);
      job.timeout = undefined;
    }
    if (!job.finishedAt) job.finishedAt = new Date().toISOString();
    job.status = status;
    if (err) job.error = redactError(err);
    if (job.channel) {
      try {
        job.channel.removeAllListeners();
      } catch {
        /* ignore */
      }
      job.channel = undefined;
    }
  }

  private formatStatus(job: ExecJob, opts: ExecStatusOpts): ExecStatusResult {
    const maxBytes = Math.min(Math.max(opts.maxBytes ?? 200_000, 1), 5_000_000);
    return {
      ...this.publicInfo(job),
      stdout: job.stdout.read(opts.stdoutOffset, maxBytes),
      stderr: job.stderr.read(opts.stderrOffset, maxBytes),
    };
  }

  private publicInfo(job: ExecJob): ExecJobPublicInfo {
    return {
      jobId: job.jobId,
      connectionName: job.connectionName,
      command: job.command,
      cwd: job.cwd,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      timedOut: job.timedOut,
      remotePid: job.remotePid,
      stdoutBytes: job.stdout.totalBytes,
      stderrBytes: job.stderr.totalBytes,
      error: job.error,
    };
  }

  private getJob(jobId: string): ExecJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`no such exec job: ${jobId}`);
    return job;
  }

  private isFinished(job: ExecJob): boolean {
    return (
      job.status === "exited" ||
      job.status === "error" ||
      job.status === "cancelled" ||
      job.status === "timed_out" ||
      job.status === "connection_closed"
    );
  }

  private nextJobId(): string {
    const random = Math.random().toString(36).slice(2, 10);
    return `job_${Date.now().toString(36)}_${random}`;
  }
}
