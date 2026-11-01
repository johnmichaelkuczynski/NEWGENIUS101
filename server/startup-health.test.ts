import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { registerStartupHealth } from "./startup-health";

test("production homepage and health check bypass failing session/database middleware", async () => {
  const app = express();
  registerStartupHealth(app, true);
  let dependencyRequests = 0;
  app.use((_req, res) => {
    dependencyRequests++;
    res.status(503).send("Session/database unavailable");
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const cookie of ["", "connect.sid=unavailable-session"]) {
      const response = await fetch(base + "/", { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<!doctype html>/i);
    }
    const health = await fetch(base + "/healthz");
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
    assert.equal(dependencyRequests, 0);
    assert.equal((await fetch(base + "/api/usage/status")).status, 503);
    assert.equal(dependencyRequests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
