import assert from "node:assert/strict";
import test from "node:test";
import { parseSSHProxyJumpFromConfigOutput } from "../src/system/sshConfigAlias.js";

test("parses single and multi-hop ProxyJump values from ssh -G output", () => {
  assert.equal(
    parseSSHProxyJumpFromConfigOutput("hostname target.internal\nproxyjump jumper\nport 22\n"),
    "jumper",
  );
  assert.equal(
    parseSSHProxyJumpFromConfigOutput(
      "hostname target.internal\nproxyjump user@jump1:2222,jump2\nport 22\n",
    ),
    "user@jump1:2222,jump2",
  );
});

test("treats missing or disabled ProxyJump as direct connection", () => {
  assert.equal(parseSSHProxyJumpFromConfigOutput("hostname target.internal\nport 22\n"), null);
  assert.equal(
    parseSSHProxyJumpFromConfigOutput("hostname target.internal\nproxyjump none\n"),
    null,
  );
});
