import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import extension, {
  normalizeAgentName,
  renameAgent,
  sanitizeTitle,
} from "../scripts/herdr-agent-session-title-omp.mjs";

assert.equal(sanitizeTitle("  hello\u0000\tworld  "), "hello world");
assert.equal(normalizeAgentName("Feature: OMP titles"), "feature-omp-titles");
assert.equal(normalizeAgentName("123 Über_task!!!\nNext"), "session-123-ber-task-next");
assert.equal(normalizeAgentName("x".repeat(80)), "x".repeat(32));
assert.equal(normalizeAgentName("\u0000\t"), undefined);

const originalEnvironment = Object.fromEntries(
  ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"].map((key) => [key, process.env[key]]),
);
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-omp-extension-"));
const requests = [];
const server = net.createServer((client) => {
  let input = "";
  client.setEncoding("utf8");
  client.on("data", (chunk) => {
    input += chunk;
    if (!input.endsWith("\n")) return;
    requests.push(JSON.parse(input));
    client.end('{"id":"test","result":{"type":"ok"}}\n');
  });
});

// Drive background work with a virtual clock so a late title does not cost
// seconds of wall time. Socket requests still use the real transport.
let now = 0;
let nextTimer = 0;
const timers = new Map();
const context = {
  mode: "tui",
  setInterval(callback, interval) {
    const timer = ++nextTimer;
    timers.set(timer, { callback, interval, due: now + interval });
    return timer;
  },
  setTimeout(callback, interval) {
    const timer = ++nextTimer;
    timers.set(timer, { callback, due: now + interval });
    return timer;
  },
  clearTimer(timer) { timers.delete(timer); },
};
const advance = async (milliseconds) => {
  const end = now + milliseconds;
  while (true) {
    const entry = [...timers.entries()]
      .filter(([, timer]) => timer.due <= end)
      .sort((a, b) => a[1].due - b[1].due)[0];
    if (!entry) break;
    const [id, timer] = entry;
    now = timer.due;
    if (timer.interval) timer.due += timer.interval;
    else timers.delete(id);
    await timer.callback();
  }
  now = end;
};
let sessionTitle;
const handlers = new Map();
extension({
  getSessionName: () => sessionTitle,
  on: (event, handler) => handlers.set(event, handler),
});
const emit = async (event, payload = {}) => handlers.get(event)?.(payload, context);
const expectRename = (name) => {
  const request = requests.shift();
  assert.ok(request, `session title ${JSON.stringify(name)} was not synchronized`);
  assert.equal(request.method, "agent.rename");
  assert.deepEqual(request.params, { target: "w1:p42", name });
  assert.match(request.id, /^plugin:herdr-agent-session-title:\d+:\d{6}$/);
  assert.deepEqual(requests, [], "duplicate rename requests");
};

try {
  const socketPath = path.join(tempDirectory, "herdr.sock");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  delete process.env.HERDR_ENV;
  sessionTitle = "outside herdr";
  await emit("session_start");
  await advance(10_000);
  assert.deepEqual(requests, []);

  assert.equal(await renameAgent("socket failure", {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p42",
    HERDR_SOCKET_PATH: path.join(tempDirectory, "missing.sock"),
  }), false);

  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p42";
  process.env.HERDR_SOCKET_PATH = socketPath;
  // Task/scout runtimes initialize extensions in print mode.
  context.mode = "print";
  sessionTitle = "Subagent title";
  await emit("session_start");
  await advance(10_000);
  assert.deepEqual(requests, [], "subagents must not rename the containing pane");
  context.mode = "tui";

  // Resumed sessions must synchronize without waiting for another model turn.
  sessionTitle = "Resumed session";
  await emit("session_start");
  expectRename("resumed-session");
  await advance(10_000);
  assert.deepEqual(requests, [], "unchanged title must not repeatedly rename");

  // No input or session_stop event accompanies an RPC title change.
  sessionTitle = "RPC rename";
  await advance(1_000);
  expectRename("rpc-rename");

  // A new session can stay unnamed longer than the old five-second deadline.
  sessionTitle = undefined;
  await emit("session_start");
  await emit("session_stop");
  await advance(30_000);
  assert.deepEqual(requests, []);
  sessionTitle = "Late generated title";
  await advance(1_000);
  expectRename("late-generated-title");

  await emit("input", { text: "/rename Slow manual rename" });
  await advance(30_000);
  sessionTitle = "Slow manual rename";
  await advance(1_000);
  expectRename("slow-manual-rename");

  // Switching sessions resets deduplication, even if their titles match.
  await emit("session_start");
  expectRename("slow-manual-rename");
  await emit("session_shutdown");
  sessionTitle = "After shutdown";
  await advance(10_000);
  assert.deepEqual(requests, []);
} finally {
  timers.clear();
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}
console.log("test-omp-extension: OK");
