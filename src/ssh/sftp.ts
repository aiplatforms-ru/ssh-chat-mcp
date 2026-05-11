/**
 * SFTP operations: upload/download files, recursive upload, read/write remote files.
 *
 * Uses ssh2's SFTP subsystem only — no spawning of external `scp`/`rsync`.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import type { Client as SshClient, SFTPWrapper } from "ssh2";
import type { ConnectionDescriptor } from "../types.js";
import { redactString } from "../security/redact.js";

/** Promisified `client.sftp()`. */
function openSftp(client: SshClient): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

/** POSIX path join — remote paths must always use forward slashes. */
function remoteJoin(...parts: string[]): string {
  const filtered = parts.filter((p) => p && p.length > 0);
  if (filtered.length === 0) return "";
  let out = filtered.join("/");
  // Collapse multiple slashes but preserve a leading slash.
  const leadingSlash = out.startsWith("/");
  out = out.replace(/\/+/g, "/");
  if (!leadingSlash && out.startsWith("/")) out = out.slice(1);
  return out;
}

function remoteDirname(p: string): string {
  if (p === "/" || p === "") return p;
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  return trimmed.slice(0, idx);
}

/** mkdir on the remote, ignoring "already exists". */
function sftpMkdir(sftp: SFTPWrapper, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(dir, (err) => {
      if (!err) return resolve();
      // ssh2 surfaces these as errors with a numeric `code` (SFTP status code).
      // 4 = FAILURE (often "exists"), 11 = FILE_ALREADY_EXISTS, plus errno EEXIST.
      const code = (err as unknown as { code?: number | string }).code;
      if (
        code === 4 ||
        code === 11 ||
        code === "EEXIST" ||
        /exists/i.test(err.message ?? "")
      ) {
        return resolve();
      }
      reject(err);
    });
  });
}

function sftpStat(
  sftp: SFTPWrapper,
  remotePath: string,
): Promise<{ exists: boolean; isDirectory: boolean }> {
  return new Promise((resolve) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) return resolve({ exists: false, isDirectory: false });
      resolve({ exists: true, isDirectory: stats.isDirectory() });
    });
  });
}

/** Recursive mkdir -p over SFTP. */
async function ensureRemoteDir(sftp: SFTPWrapper, dir: string): Promise<void> {
  if (!dir || dir === "/" || dir === ".") return;
  const norm = dir.replace(/\\/g, "/");
  const parts = norm.split("/");
  const acc: string[] = [];
  if (norm.startsWith("/")) acc.push("");
  for (const p of parts) {
    if (!p) continue;
    acc.push(p);
    const cur = acc.join("/") || "/";
    const st = await sftpStat(sftp, cur);
    if (st.exists) {
      if (!st.isDirectory) {
        throw new Error(`remote path exists and is not a directory: ${cur}`);
      }
      continue;
    }
    await sftpMkdir(sftp, cur);
  }
}

function sftpFastPut(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  mode?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const opts = mode !== undefined ? { mode } : undefined;
    sftp.fastPut(localPath, remotePath, opts ?? {}, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpFastGet(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, {}, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpWriteFile(
  sftp: SFTPWrapper,
  remotePath: string,
  content: Buffer,
  mode?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null | undefined) => {
      if (err) reject(err);
      else resolve();
    };
    if (mode !== undefined) {
      sftp.writeFile(remotePath, content, { mode }, cb);
    } else {
      sftp.writeFile(remotePath, content, cb);
    }
  });
}

function sftpReadFileBounded(
  sftp: SFTPWrapper,
  remotePath: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean; totalSize: number }> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (statErr, stats) => {
      if (statErr) return reject(statErr);
      const totalSize = Number(stats.size);
      const stream = sftp.createReadStream(remotePath, { start: 0, end: maxBytes });
      const chunks: Buffer[] = [];
      let received = 0;
      let resolved = false;
      stream.on("data", (chunk: Buffer) => {
        if (resolved) return;
        const remaining = maxBytes - received;
        if (remaining <= 0) {
          resolved = true;
          stream.destroy();
          resolve({
            buffer: Buffer.concat(chunks),
            truncated: totalSize > maxBytes,
            totalSize,
          });
          return;
        }
        const take = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(take);
        received += take.length;
        if (received >= maxBytes) {
          resolved = true;
          stream.destroy();
          resolve({
            buffer: Buffer.concat(chunks),
            truncated: totalSize > maxBytes,
            totalSize,
          });
        }
      });
      stream.on("end", () => {
        if (resolved) return;
        resolved = true;
        resolve({
          buffer: Buffer.concat(chunks),
          truncated: totalSize > maxBytes,
          totalSize,
        });
      });
      stream.on("error", (e: Error) => {
        if (resolved) return;
        resolved = true;
        reject(e);
      });
    });
  });
}

export interface UploadFileOpts {
  conn: ConnectionDescriptor;
  localPath: string;
  remotePath: string;
  mode?: number;
  mkdirParents?: boolean;
}

export async function uploadFile(opts: UploadFileOpts): Promise<{ bytesUploaded: number }> {
  const { conn, localPath, remotePath, mode, mkdirParents } = opts;
  if (!localPath) throw new Error("localPath is required");
  if (!remotePath) throw new Error("remotePath is required");

  const stat = await fs.stat(localPath);
  if (!stat.isFile()) {
    throw new Error(`localPath is not a regular file: ${localPath}`);
  }

  const sftp = await openSftp(conn.client);
  try {
    if (mkdirParents) {
      await ensureRemoteDir(sftp, remoteDirname(remotePath));
    }
    await sftpFastPut(sftp, localPath, remotePath, mode);
    return { bytesUploaded: stat.size };
  } finally {
    try {
      sftp.end();
    } catch {
      /* ignore */
    }
  }
}

export interface UploadDirOpts {
  conn: ConnectionDescriptor;
  localPath: string;
  remotePath: string;
  mkdirParents?: boolean;
  followSymlinks?: boolean;
  exclude?: string[];
}

export interface UploadDirResult {
  fileCount: number;
  dirCount: number;
  bytesUploaded: number;
}

/**
 * Recursively SFTP a local directory tree to a remote directory.
 *
 * Excludes are matched as plain basename equality (case-sensitive). Symlinks are
 * not followed unless `followSymlinks` is true.
 */
export async function uploadDirectory(opts: UploadDirOpts): Promise<UploadDirResult> {
  const {
    conn,
    localPath,
    remotePath,
    mkdirParents = true,
    followSymlinks = false,
    exclude = [],
  } = opts;
  if (!localPath) throw new Error("localPath is required");
  if (!remotePath) throw new Error("remotePath is required");

  const excludeSet = new Set(exclude);
  const rootStat = await fs.stat(localPath);
  if (!rootStat.isDirectory()) {
    throw new Error(`localPath is not a directory: ${localPath}`);
  }

  const sftp = await openSftp(conn.client);
  const result: UploadDirResult = { fileCount: 0, dirCount: 0, bytesUploaded: 0 };
  try {
    if (mkdirParents) {
      await ensureRemoteDir(sftp, remoteDirname(remotePath));
    }
    await ensureRemoteDir(sftp, remotePath);
    result.dirCount += 1;

    type StackEntry = { localDir: string; remoteDir: string };
    const stack: StackEntry[] = [{ localDir: localPath, remoteDir: remotePath }];
    while (stack.length > 0) {
      const { localDir, remoteDir } = stack.pop()!;
      const entries = await fs.readdir(localDir, { withFileTypes: true });
      for (const entry of entries) {
        if (excludeSet.has(entry.name)) continue;
        const localChild = path.join(localDir, entry.name);
        const remoteChild = remoteJoin(remoteDir, entry.name);

        // Determine effective type (with symlink policy).
        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        const isSymlink = entry.isSymbolicLink();
        if (isSymlink) {
          if (!followSymlinks) continue;
          try {
            const st = await fs.stat(localChild);
            isDir = st.isDirectory();
            isFile = st.isFile();
          } catch {
            continue;
          }
        }

        if (isDir) {
          await sftpMkdir(sftp, remoteChild);
          result.dirCount += 1;
          stack.push({ localDir: localChild, remoteDir: remoteChild });
        } else if (isFile) {
          const st = await fs.stat(localChild);
          await sftpFastPut(sftp, localChild, remoteChild);
          result.fileCount += 1;
          result.bytesUploaded += st.size;
        }
        // Other types (sockets, FIFOs, devices) are silently skipped.
      }
    }
    return result;
  } finally {
    try {
      sftp.end();
    } catch {
      /* ignore */
    }
  }
}

export interface DownloadFileOpts {
  conn: ConnectionDescriptor;
  remotePath: string;
  localPath: string;
  mkdirParents?: boolean;
}

export async function downloadFile(
  opts: DownloadFileOpts,
): Promise<{ bytesDownloaded: number }> {
  const { conn, remotePath, localPath, mkdirParents } = opts;
  if (!remotePath) throw new Error("remotePath is required");
  if (!localPath) throw new Error("localPath is required");

  if (mkdirParents) {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
  }

  const sftp = await openSftp(conn.client);
  try {
    await sftpFastGet(sftp, remotePath, localPath);
  } finally {
    try {
      sftp.end();
    } catch {
      /* ignore */
    }
  }
  const st = await fs.stat(localPath);
  return { bytesDownloaded: st.size };
}

export interface ReadRemoteFileOpts {
  conn: ConnectionDescriptor;
  remotePath: string;
  maxBytes?: number;
}

export interface ReadRemoteFileResult {
  content: string;
  bytesRead: number;
  totalSize: number;
  truncated: boolean;
}

export async function readRemoteFile(
  opts: ReadRemoteFileOpts,
): Promise<ReadRemoteFileResult> {
  const { conn, remotePath, maxBytes = 200_000 } = opts;
  if (!remotePath) throw new Error("remotePath is required");
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive integer");
  }

  const sftp = await openSftp(conn.client);
  try {
    const { buffer, truncated, totalSize } = await sftpReadFileBounded(
      sftp,
      remotePath,
      maxBytes,
    );
    return {
      content: redactString(buffer.toString("utf8")),
      bytesRead: buffer.length,
      totalSize,
      truncated,
    };
  } finally {
    try {
      sftp.end();
    } catch {
      /* ignore */
    }
  }
}

export interface WriteRemoteFileOpts {
  conn: ConnectionDescriptor;
  remotePath: string;
  content: string;
  mode?: number;
  mkdirParents?: boolean;
}

export async function writeRemoteFile(
  opts: WriteRemoteFileOpts,
): Promise<{ bytesWritten: number }> {
  const { conn, remotePath, content, mode, mkdirParents } = opts;
  if (!remotePath) throw new Error("remotePath is required");
  if (typeof content !== "string") throw new Error("content must be a string");

  const buf = Buffer.from(content, "utf8");
  const sftp = await openSftp(conn.client);
  try {
    if (mkdirParents) {
      await ensureRemoteDir(sftp, remoteDirname(remotePath));
    }
    await sftpWriteFile(sftp, remotePath, buf, mode);
    return { bytesWritten: buf.length };
  } finally {
    try {
      sftp.end();
    } catch {
      /* ignore */
    }
  }
}
