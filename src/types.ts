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
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  /** True if the command was killed because timeoutMs elapsed. */
  timedOut: boolean;
}
