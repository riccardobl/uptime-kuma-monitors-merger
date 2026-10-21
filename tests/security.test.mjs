import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("the merger requires a key and validates requests before reading metrics", async () => {
  let metricsRequests = 0;
  const metrics = createServer((req, res) => {
    metricsRequests++;
    assert.equal(req.headers.authorization, `Basic ${Buffer.from(":test-key").toString("base64")}`);
    res.writeHead(200, {"content-type": "text/plain"}).end([
      "# HELP monitor_status Monitor status",
      "# TYPE monitor_status gauge",
      'monitor_status{monitor_name="A"} 1',
      "# HELP monitor_response_time Response time",
      "# TYPE monitor_response_time gauge",
      'monitor_response_time{monitor_name="A"} 42',
      ""
    ].join("\n"));
  });
  const metricsPort = await listen(metrics);
  const probe = createServer();
  const appPort = await listen(probe);
  await new Promise(resolve => probe.close(resolve));
  const app = spawn(process.execPath, ["index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      KUMA_KEY: "test-key",
      KUMA_METRICS: `http://127.0.0.1:${metricsPort}/metrics`,
      KUMA_METRICS_MERGER_PORT: String(appPort),
      NODE_OPTIONS: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        app.stdout.on("data", chunk => {
          if (chunk.toString().includes("Listening on port")) resolve();
        });
        app.once("exit", code => reject(new Error(`merger exited: ${code}`)));
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("merger startup timed out")), 5000);
        timer.unref();
      })
    ]);
    const request = body => fetch(`http://127.0.0.1:${appPort}/`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(body)
    });
    assert.equal((await request({monitors: ["A"], apiKey: "wrong"})).status, 401);
    assert.equal((await request({monitors: [], apiKey: "test-key"})).status, 400);
    assert.equal((await request({monitors: ["A"], apiKey: "test-key", timeout: -1})).status, 400);
    assert.equal(metricsRequests, 0);

    const valid = await request({monitors: ["A"], apiKey: "test-key", timeout: 100});
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), {result: 1});
    assert.equal(metricsRequests, 1);
  } finally {
    app.kill("SIGTERM");
    if (app.exitCode === null) await new Promise(resolve => app.once("exit", resolve));
    await new Promise(resolve => metrics.close(resolve));
  }
});
