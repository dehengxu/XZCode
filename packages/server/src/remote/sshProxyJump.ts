import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex } from "node:stream";

const MAX_PROXY_STDERR_LENGTH = 4_096;

export interface SSHProxyJumpTunnelInput {
  sshExecutablePath: string;
  configPath: string;
  proxyJump: string;
  targetHost: string;
  targetPort: number;
}

export interface SSHProxyJumpTunnel {
  socket: Duplex;
  dispose(): void;
}

class SSHProxyJumpSocket extends Duplex {
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super();

    child.stdout.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) {
        child.stdout.pause();
      }
    });
    child.stdout.on("end", () => this.push(null));
    child.stdout.on("error", (error) => this.destroy(error));
    child.stdin.on("error", (error) => this.destroy(error));
  }

  override _read(): void {
    this.child.stdout.resume();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.child.stdin.destroyed || !this.child.stdin.writable) {
      callback(new Error("ProxyJump tunnel stdin 已关闭"));
      return;
    }
    this.child.stdin.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.child.stdin.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.child.stdout.destroy();
    this.child.stdin.destroy();
    this.child.stderr.destroy();
    if (this.child.exitCode == null && !this.child.killed) {
      this.child.kill();
    }
    callback(error);
  }
}

function hasWhitespaceOrControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (/\s/u.test(character) || codePoint <= 31 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

export function parseSSHProxyJumpEndpoints(proxyJump: string): string[] {
  if (!proxyJump || proxyJump.toLowerCase() === "none") {
    throw new Error("ProxyJump 必须至少包含一个跳板 endpoint");
  }

  const endpoints = proxyJump.split(",");
  for (const endpoint of endpoints) {
    // spawn 不经过 shell，但 OpenSSH 仍会解析以 `-` 开头的目标为选项。
    // 同时拒绝空白和控制字符，避免一个 endpoint 被 OpenSSH 拆成多段参数语义。
    if (
      endpoint.length === 0 ||
      endpoint.startsWith("-") ||
      endpoint.toLowerCase() === "none" ||
      hasWhitespaceOrControlCharacter(endpoint)
    ) {
      throw new Error("ProxyJump 包含无效的跳板 endpoint");
    }
  }

  return endpoints;
}

function formatForwardDestination(host: string, port: number): string {
  const normalizedHost = host.trim();
  if (!normalizedHost || hasWhitespaceOrControlCharacter(normalizedHost)) {
    throw new Error("ProxyJump 目标主机无效");
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("ProxyJump 目标端口无效");
  }

  const bracketedHost =
    normalizedHost.includes(":") && !/^\[.*\]$/u.test(normalizedHost)
      ? `[${normalizedHost}]`
      : normalizedHost;
  return `${bracketedHost}:${port}`;
}

export function buildSSHProxyJumpArguments(
  input: Omit<SSHProxyJumpTunnelInput, "sshExecutablePath">,
): string[] {
  if (!input.configPath.trim()) {
    throw new Error("ProxyJump SSH config 路径不能为空");
  }

  const endpoints = parseSSHProxyJumpEndpoints(input.proxyJump);
  const finalJump = endpoints.at(-1);
  if (!finalJump) {
    throw new Error("ProxyJump 必须至少包含一个跳板 endpoint");
  }

  const args = [
    "-T",
    "-F",
    input.configPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ClearAllForwardings=yes",
  ];
  if (endpoints.length > 1) {
    args.push("-J", endpoints.slice(0, -1).join(","));
  }
  args.push("-W", formatForwardDestination(input.targetHost, input.targetPort), "--", finalJump);
  return args;
}

function formatProxyJumpExitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): Error {
  const status = code == null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`;
  const detail = stderr.trim();
  return new Error(
    detail
      ? `ProxyJump 隧道异常退出（${status}）：${detail}`
      : `ProxyJump 隧道异常退出（${status}）`,
  );
}

export function createSSHProxyJumpTunnel(input: SSHProxyJumpTunnelInput): SSHProxyJumpTunnel {
  const args = buildSSHProxyJumpArguments(input);
  const child = spawn(input.sshExecutablePath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      SSH_ASKPASS_REQUIRE: "never",
      SSH_ASKPASS: "",
      DISPLAY: "",
    },
  });
  const socket = new SSHProxyJumpSocket(child);
  const jumpCount = parseSSHProxyJumpEndpoints(input.proxyJump).length;
  let disposed = false;
  let stderr = "";

  console.info(`[ssh] ProxyJump tunnel started (${jumpCount} hop${jumpCount === 1 ? "" : "s"})`);
  child.stderr.on("data", (chunk: Buffer | string) => {
    if (stderr.length >= MAX_PROXY_STDERR_LENGTH) {
      return;
    }
    stderr = `${stderr}${chunk.toString()}`.slice(0, MAX_PROXY_STDERR_LENGTH);
  });
  child.once("error", (error) => {
    if (!disposed) {
      socket.destroy(new Error(`无法启动 ProxyJump 隧道：${error.message}`));
    }
  });
  child.once("close", (code, signal) => {
    if (!disposed && !socket.destroyed) {
      socket.destroy(formatProxyJumpExitError(code, signal, stderr));
    }
  });

  return {
    socket,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      socket.destroy();
    },
  };
}
