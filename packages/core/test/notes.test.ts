import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHub, type TestHub } from "./helpers.js";

let t: TestHub;

beforeAll(async () => {
  t = await startHub();
});

afterAll(async () => {
  await t.stop();
});

describe("server notes", () => {
  it("are saved with the server, can be changed, and are removed when emptied", async () => {
    const add = await t.api("POST", "/api/servers", { name: "Noted", transport: "stdio", command: "npx", enabled: false, notes: "Token comes from the team vault.\nExpires monthly." });
    expect(add.status).toBe(201);
    expect((await t.api("GET", "/api/servers/noted")).body.config.notes).toBe("Token comes from the team vault.\nExpires monthly.");

    await t.api("PUT", "/api/servers/noted", { notes: "Renewed in October." });
    expect((await t.api("GET", "/api/servers/noted")).body.config.notes).toBe("Renewed in October.");

    // Editing something else keeps them.
    await t.api("PUT", "/api/servers/noted", { command: "uvx" });
    expect((await t.api("GET", "/api/servers/noted")).body.config.notes).toBe("Renewed in October.");

    await t.api("PUT", "/api/servers/noted", { notes: "   " });
    expect((await t.api("GET", "/api/servers/noted")).body.config).not.toHaveProperty("notes");
  });

  it("headers and variables can all be removed with an empty object", async () => {
    await t.api("POST", "/api/servers", { name: "Remote", transport: "http", url: "https://example.com/mcp", enabled: false, headers: { A: "1" } });
    await t.api("PUT", "/api/servers/remote", { headers: {} });
    expect((await t.api("GET", "/api/servers/remote")).body.config).not.toHaveProperty("headers");

    await t.api("POST", "/api/servers", { name: "Local", transport: "stdio", command: "npx", enabled: false, env: { A: "1" } });
    await t.api("PUT", "/api/servers/local", { env: {} });
    expect((await t.api("GET", "/api/servers/local")).body.config).not.toHaveProperty("env");
  });

  it("are left out when blank at creation and limited in length", async () => {
    const blank = await t.api("POST", "/api/servers", { name: "Blank", transport: "stdio", command: "npx", enabled: false, notes: "" });
    expect(blank.status).toBe(201);
    expect((await t.api("GET", "/api/servers/blank")).body.config).not.toHaveProperty("notes");

    const huge = await t.api("POST", "/api/servers", { name: "Huge", transport: "stdio", command: "npx", enabled: false, notes: "x".repeat(10_001) });
    expect(huge.status).toBe(400);
  });
});
