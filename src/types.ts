/**
 * Shared type definitions for ssh-chat-mcp.
 */

import type { Client as SshClient } from "ssh2";

export interface ConnectionDescriptor {
  /** User-provided handle for this connection. */
  connectionName: string;
  /** Remote host (hostname or IP). */
  host: string;
  /** SSH port. */
  port: number;
  /** Remote username. */
  username: string;
  /** ISO timestamp when the connection became ready. */
  connectedAt: string;
  /** Current lifecycle status. */
  status: "connecting" | "connected" | "closing" | "closed" | "error";
  /** ISO timestamp when the connection stopped being usable. */
  closedAt?: string;
  /** Last non-sensitive error seen on this SSH client. */
  lastError?: string;
  /** Live ssh2 client. Owned by ConnectionManager. */
  client: SshClient;
  /**
   * Sensitive auth material kept in memory only for the lifetime of the connection.
   * Cleared on disconnect.
   */
  secrets: {
    password?: string;
    privateKey?: string;
    passphrase?: string;
  };
}

/** Public, sanitised view of a connection — never contains secrets. */
export interface ConnectionPublicInfo {
  connectionName: string;
  host: string;
  port: number;
  username: string;
  connectedAt: string;
  status: ConnectionDescriptor["status"];
  closedAt?: string;
  lastError?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  /** True if the command was killed because timeoutMs elapsed. */
  timedOut: boolean;
}

export type ExecJobStatus =
  | "starting"
  | "running"
  | "exited"
  | "error"
  | "cancelled"
  | "timed_out"
  | "connection_closed";

export interface ExecJobPublicInfo {
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
  stdoutBytes: number;
  stderrBytes: number;
  error?: string;
}
