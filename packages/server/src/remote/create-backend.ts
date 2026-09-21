import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolveSSHProxyJumpFromLocalConfig } from "@zcode/services/node";
import type { RemoteTarget } from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";

export async function createRemoteBackend(target: RemoteTarget): Promise<IRemoteBackend> {
  switch (target.kind) {
    case "ssh": {
      const { SSHBackend } = await import("./ssh-backend.js");
      let privateKey: string | Buffer | undefined;
      if (target.privateKeyPath) {
        const keyPath = target.privateKeyPath.replace(/^~/, homedir());
        privateKey = await readFile(keyPath);
      }
      const sshConfigAlias = target.sshConfigAlias?.trim();
      const proxyJump = sshConfigAlias
        ? await resolveSSHProxyJumpFromLocalConfig(sshConfigAlias)
        : null;

      return new SSHBackend({
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password,
        privateKeyPath: target.privateKeyPath,
        privateKeyPassphrase: target.privateKeyPassphrase,
        privateKey,
        ...(proxyJump ? { proxyJump } : {}),
      });
    }
    case "wsl": {
      const { WSLBackend } = await import("./wsl-backend.js");
      return new WSLBackend(target);
    }
    case "docker": {
      const { DockerBackend } = await import("./docker-backend.js");
      return new DockerBackend(target);
    }
  }
}
