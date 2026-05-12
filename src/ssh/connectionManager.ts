/**
 * In-memory SSH connection registry.
 *
 * All credentials live only inside ConnectionDescriptor.secrets and are wiped
 * on disconnect. Nothing is persisted to disk.
 */

import { Client as SshClient, type ConnectConfig } from "ssh2";
import type { ConnectionDescriptor, ConnectionPublicInfo } from "../types.js";
import { clearSecrets, redactError } from "../security/redact.js";

export interface ConnectOptions {
  connectionName: string;
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  readyTimeoutMs?: number;
  keepaliveIntervalMs?: number;
}

export class ConnectionManager {
  private readonly conns = new Map<string, ConnectionDescriptor>();

  private forgetConnection(connectionName: string, client: SshClient): void {
    const d = this.conns.get(connectionName);
    if (!d || d.client !== client) return;
    d.status = "closed";
    d.closedAt = new Date().toISOString();
    clearSecrets(d.secrets as unknown as Record<string, unknown>, [
      "password",
      "privateKey",
      "passphrase",
    ]);
    this.conns.delete(connectionName);
  }

  /**
   * Open a new SSH connection and register it under `connectionName`.
   * If a connection with that name already exists, it is closed and replaced.
   */
  async connect(opts: ConnectOptions): Promise<ConnectionPublicInfo> {
    const {
      connectionName,
      host,
      username,
      port = 22,
      password,
      privateKey,
      passphrase,
      readyTimeoutMs = 30_000,
      keepaliveIntervalMs = 10_000,
    } = opts;

    if (!connectionName || typeof connectionName !== "string") {
      throw new Error("connectionName is required");
    }
    if (!host) throw new Error("host is required");
    if (!username) throw new Error("username is required");
    if (!password && !privateKey) {
      throw new Error("either password or privateKey must be provided");
    }
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new Error("port must be an integer in [1, 65535]");
    }

    // Replace any existing connection with the same name.
    if (this.conns.has(connectionName)) {
      await this.disconnect(connectionName).catch(() => undefined);
    }

    const client = new SshClient();
    const descriptor: ConnectionDescriptor = {
      connectionName,
      host,
      port,
      username,
      connectedAt: "",
      status: "connecting",
      client,
      secrets: { password, privateKey, passphrase },
    };
    this.conns.set(connectionName, descriptor);

    client.on("error", (err) => {
      const d = this.conns.get(connectionName);
      if (d && d.client === client) {
        d.status = "error";
        d.lastError = redactError(err);
        d.closedAt = new Date().toISOString();
      }
      console.error(`[ssh-chat-mcp] ssh client error (${connectionName}):`, redactError(err));
    });

    client.once("close", () => {
      this.forgetConnection(connectionName, client);
    });

    const config: ConnectConfig = {
      host,
      port,
      username,
      readyTimeout: readyTimeoutMs,
      keepaliveInterval: keepaliveIntervalMs,
      // Accept any host key fingerprint. Host-key trust is out of scope for a
      // zero-config, chat-driven MCP — the *client/user* approves the action of
      // connecting, and TOFU pinning would require disk persistence which this
      // project deliberately avoids.
      algorithms: undefined,
    };
    if (password) config.password = password;
    if (privateKey) {
      config.privateKey = privateKey;
      if (passphrase) config.passphrase = passphrase;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          client.removeListener("error", onError);
          resolve();
        };
        const onError = (err: Error) => {
          client.removeListener("ready", onReady);
          reject(err);
        };
        client.once("ready", onReady);
        client.once("error", onError);
        client.connect(config);
      });
    } catch (err) {
      descriptor.status = "error";
      descriptor.lastError = redactError(err);
      descriptor.closedAt = new Date().toISOString();
      try {
        client.end();
      } catch {
        /* ignore */
      }
      this.conns.delete(connectionName);
      clearSecrets(descriptor.secrets as unknown as Record<string, unknown>, [
        "password",
        "privateKey",
        "passphrase",
      ]);
      throw err;
    }

    descriptor.status = "connected";
    descriptor.connectedAt = new Date().toISOString();

    return this.publicInfo(descriptor);
  }

  /** Look up an active connection; throws if missing or not connected. */
  get(connectionName: string): ConnectionDescriptor {
    const d = this.conns.get(connectionName);
    if (!d) {
      throw new Error(`no such connection: ${connectionName}`);
    }
    if (d.status !== "connected") {
      throw new Error(`connection ${connectionName} is not connected (status=${d.status})`);
    }
    return d;
  }

  /** Close a connection and remove all credentials from memory. */
  async disconnect(connectionName: string): Promise<boolean> {
    const d = this.conns.get(connectionName);
    if (!d) {
      return false;
    }
    d.status = "closing";
    try {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          d.client.once("close", finish);
          d.client.end();
        } catch {
          finish();
          return;
        }
        // Hard cap so a stuck socket doesn't hang the tool call.
        setTimeout(finish, 5_000).unref?.();
      });
    } finally {
      clearSecrets(d.secrets as unknown as Record<string, unknown>, [
        "password",
        "privateKey",
        "passphrase",
      ]);
      d.status = "closed";
      d.closedAt = new Date().toISOString();
      this.conns.delete(connectionName);
    }
    return true;
  }

  /** Disconnect every active connection. Used during shutdown. */
  async disconnectAll(): Promise<void> {
    const names = [...this.conns.keys()];
    await Promise.allSettled(names.map((n) => this.disconnect(n)));
  }

  /** Public, sanitised list of connections — never includes secrets. */
  list(): ConnectionPublicInfo[] {
    return [...this.conns.values()].map((d) => this.publicInfo(d));
  }

  private publicInfo(d: ConnectionDescriptor): ConnectionPublicInfo {
    return {
      connectionName: d.connectionName,
      host: d.host,
      port: d.port,
      username: d.username,
      connectedAt: d.connectedAt,
      status: d.status,
      closedAt: d.closedAt,
      lastError: d.lastError,
    };
  }
}
