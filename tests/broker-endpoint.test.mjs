import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createBrokerEndpoint, parseBrokerEndpoint } from "../plugins/agy/scripts/lib/broker-endpoint.mjs";

test("createBrokerEndpoint uses Unix sockets on non-Windows platforms", () => {
  const sessionDir = "/tmp/cxc-12345";
  const endpoint = createBrokerEndpoint(sessionDir, "darwin");
  // The module joins the socket path with the host's path separator, so derive
  // the expected value the same way to keep this assertion stable on Windows.
  const expectedSocket = path.join(sessionDir, "broker.sock");
  assert.equal(endpoint, `unix:${expectedSocket}`);
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "unix",
    path: expectedSocket
  });
});

test("createBrokerEndpoint uses named pipes on Windows", () => {
  const endpoint = createBrokerEndpoint("C:\\\\Temp\\\\cxc-12345", "win32");
  assert.equal(endpoint, "pipe:\\\\.\\pipe\\cxc-12345-Antigravity-app-server");
  assert.deepEqual(parseBrokerEndpoint(endpoint), {
    kind: "pipe",
    path: "\\\\.\\pipe\\cxc-12345-Antigravity-app-server"
  });
});
