import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHub, type TestHub } from "./helpers.js";

describe("server order", () => {
  let t: TestHub;
  const order = async () => (await t.api("GET", "/api/state")).body.servers.map((s: { id: string }) => s.id);

  beforeAll(async () => {
    t = await startHub();
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
      await t.api("POST", "/api/servers", { name, transport: "stdio", command: process.execPath, args: ["-e", ""], enabled: false, lifecycle: "on-demand" });
    }
  });
  afterAll(async () => {
    await t.stop();
  });

  it("new servers go to the end", async () => {
    expect(await order()).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });

  it("saves the order the cards were dragged into, and keeps it in the config file", async () => {
    expect((await t.api("PUT", "/api/servers/order", { ids: ["delta", "alpha", "charlie", "bravo"] })).status).toBe(200);
    expect(await order()).toEqual(["delta", "alpha", "charlie", "bravo"]);
    const saved = JSON.parse(readFileSync(join(t.dir, "config.json"), "utf-8"));
    expect(saved.servers.map((s: { id: string }) => s.id)).toEqual(["delta", "alpha", "charlie", "bravo"]);
  });

  it("ignores unknown ids and keeps servers that weren't listed after the listed ones", async () => {
    await t.api("PUT", "/api/servers/order", { ids: ["bravo", "nope", "bravo", "alpha"] });
    expect(await order()).toEqual(["bravo", "alpha", "delta", "charlie"]);
  });

  it("a server added later joins the end of the saved order", async () => {
    await t.api("POST", "/api/servers", { name: "Echo", transport: "stdio", command: process.execPath, args: ["-e", ""], enabled: false, lifecycle: "on-demand" });
    expect(await order()).toEqual(["bravo", "alpha", "delta", "charlie", "echo"]);
  });

  it("rejects a body that isn't a list of ids", async () => {
    expect((await t.api("PUT", "/api/servers/order", { ids: "alpha" })).status).toBe(400);
    expect((await t.api("PUT", "/api/servers/order", { ids: [1, 2] })).status).toBe(400);
    expect((await t.api("PUT", "/api/servers/order", {})).status).toBe(400);
  });
});
