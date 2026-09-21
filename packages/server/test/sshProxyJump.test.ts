import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSSHProxyJumpArguments,
  createSSHProxyJumpTunnel,
  parseSSHProxyJumpEndpoints,
} from "../src/remote/sshProxyJump.js";

const baseInput = {
  configPath: "/tmp/ssh config",
  targetHost: "target.internal",
  targetPort: 22,
};

test("builds a single-hop OpenSSH stdio tunnel without a nested -J option", () => {
  assert.deepEqual(
    buildSSHProxyJumpArguments({
      ...baseInput,
      proxyJump: "jumper",
    }),
    [
      "-T",
      "-F",
      "/tmp/ssh config",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ClearAllForwardings=yes",
      "-W",
      "target.internal:22",
      "--",
      "jumper",
    ],
  );
});

test("builds a multi-hop tunnel by forwarding through the last jump endpoint", () => {
  assert.deepEqual(
    buildSSHProxyJumpArguments({
      ...baseInput,
      proxyJump: "jump1,user@jump2:2222,jump3",
    }),
    [
      "-T",
      "-F",
      "/tmp/ssh config",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ClearAllForwardings=yes",
      "-J",
      "jump1,user@jump2:2222",
      "-W",
      "target.internal:22",
      "--",
      "jump3",
    ],
  );
});

test("formats IPv6 target addresses for OpenSSH -W", () => {
  const args = buildSSHProxyJumpArguments({
    ...baseInput,
    targetHost: "2001:db8::10",
    targetPort: 2200,
    proxyJump: "jumper",
  });
  assert.deepEqual(args.slice(-4), ["-W", "[2001:db8::10]:2200", "--", "jumper"]);
});

test("rejects malformed or option-like ProxyJump endpoints before spawn", () => {
  for (const value of ["", "jump1,,jump2", "jump one", "-oProxyCommand=evil", "jump\nnext"]) {
    assert.throws(() => parseSSHProxyJumpEndpoints(value), /ProxyJump/);
  }
});

test(
  "bridges child stdio as a duplex socket and disposes it idempotently",
  { skip: process.platform === "win32", timeout: 5_000 },
  async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "zcode-proxy-jump-"));
    const fakeSshPath = join(fixtureDir, "fake-ssh");
    await writeFile(fakeSshPath, "#!/usr/bin/env node\nprocess.stdin.pipe(process.stdout);\n");
    await chmod(fakeSshPath, 0o755);

    const tunnel = createSSHProxyJumpTunnel({
      ...baseInput,
      sshExecutablePath: fakeSshPath,
      proxyJump: "jumper",
    });
    try {
      const dataPromise = once(tunnel.socket, "data");
      tunnel.socket.write(Buffer.from("ping"));
      const [chunk] = await dataPromise;
      assert.equal(String(chunk), "ping");
      tunnel.dispose();
      tunnel.dispose();
      assert.equal(tunnel.socket.destroyed, true);
    } finally {
      tunnel.dispose();
      await rm(fixtureDir, { recursive: true, force: true });
    }
  },
);

test(
  "surfaces bounded OpenSSH stderr when the jump process exits",
  { skip: process.platform === "win32", timeout: 5_000 },
  async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "zcode-proxy-jump-error-"));
    const fakeSshPath = join(fixtureDir, "fake-ssh");
    await writeFile(
      fakeSshPath,
      '#!/usr/bin/env node\nprocess.stderr.write("jump failed\\n");\nprocess.exit(12);\n',
    );
    await chmod(fakeSshPath, 0o755);

    const tunnel = createSSHProxyJumpTunnel({
      ...baseInput,
      sshExecutablePath: fakeSshPath,
      proxyJump: "jumper",
    });
    try {
      const error = await new Promise<Error>((resolve) => tunnel.socket.once("error", resolve));
      assert.match(error.message, /exit code 12/);
      assert.match(error.message, /jump failed/);
    } finally {
      tunnel.dispose();
      await rm(fixtureDir, { recursive: true, force: true });
    }
  },
);
