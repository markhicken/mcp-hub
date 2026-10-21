import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCK, startHub, waitFor, type TestHub } from "./helpers.js";

let t: TestHub;
const server = async (id: string) => (await t.api("GET", `/api/servers/${id}`)).body;
const enabled = async () => Object.fromEntries((await t.api("GET", "/api/state")).body.servers.map((s: { id: string; config: { enabled: boolean } }) => [s.id, s.config.enabled]));

beforeAll(async () => {
  t = await startHub();
  const add = (name: string, labels: string[]) => t.api("POST", "/api/servers", { name, transport: "stdio", command: process.execPath, args: [MOCK], enabled: false, lifecycle: "on-demand", labels });
  await add("Jira", ["Work"]);
  await add("Wiki", ["work", "Docs"]);
  await add("Music", ["personal"]);
  await add("Files", []);
});

afterAll(async () => {
  await t.stop();
});

describe("server labels", () => {
  it("are tidied: trimmed, repeats dropped, spelled like the same label elsewhere, and left out when empty", async () => {
    expect((await server("wiki")).config.labels).toEqual(["Work", "Docs"]);
    expect((await server("files")).config).not.toHaveProperty("labels");
    await t.api("PUT", "/api/servers/music", { labels: ["  personal  ", "PERSONAL", "late   night", ""] });
    expect((await server("music")).config.labels).toEqual(["personal", "late night"]);
    await t.api("PUT", "/api/servers/music", { labels: ["late night"] });
    expect((await server("music")).config.labels).toEqual(["late night"]);
    await t.api("PUT", "/api/servers/music", { labels: [] });
    expect((await server("music")).config).not.toHaveProperty("labels");
    await t.api("PUT", "/api/servers/music", { labels: ["personal"] });
  });

  it("refuses labels that aren't a short list of text", async () => {
    expect((await t.api("PUT", "/api/servers/music", { labels: "personal" })).status).toBe(400);
    expect((await t.api("PUT", "/api/servers/music", { labels: [1] })).status).toBe(400);
    expect((await t.api("PUT", "/api/servers/music", { labels: ["x".repeat(41)] })).status).toBe(400);
    expect((await t.api("PUT", "/api/servers/music", { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) })).status).toBe(400);
  });

  it("turn a labeled group on and off, and switching to one turns every other server off", async () => {
    await t.api("POST", "/api/servers/files/enable");
    const on = await t.api("POST", "/api/labels/apply", { label: "WORK", action: "on" });
    expect(on.body).toEqual({ label: "Work", on: ["Jira", "Wiki"], off: [] });
    expect(await enabled()).toEqual({ jira: true, wiki: true, music: false, files: true });

    const only = await t.api("POST", "/api/labels/apply", { label: "docs", action: "only" });
    expect(only.body).toEqual({ label: "Docs", on: [], off: ["Jira", "Files"] });
    expect(await enabled()).toEqual({ jira: false, wiki: true, music: false, files: false });

    await t.api("POST", "/api/labels/apply", { label: "work", action: "off" });
    expect(await enabled()).toEqual({ jira: false, wiki: false, music: false, files: false });
  });

  it("turn every server on or off when no label is given, but only switches to a real label", async () => {
    const on = await t.api("POST", "/api/labels/apply", { action: "on" });
    expect(on.body.label).toBeNull();
    expect([...on.body.on].sort()).toEqual(["Files", "Jira", "Music", "Wiki"]);
    expect(await enabled()).toEqual({ jira: true, wiki: true, music: true, files: true });
    await t.api("POST", "/api/labels/apply", { action: "off" });
    expect(await enabled()).toEqual({ jira: false, wiki: false, music: false, files: false });
    expect((await t.api("POST", "/api/labels/apply", { action: "only" })).status).toBe(400);
  });

  it("says why the servers it starts were started, and records the switch in History", async () => {
    await t.api("POST", "/api/labels/apply", { label: "personal", action: "only" });
    const events = await waitFor(async () => {
      const ev = (await t.api("GET", "/api/history?limit=50")).body.events as Array<{ title: string; trigger: string; serverId: string }>;
      return ev.some((e) => e.serverId === "music" && e.trigger === 'You switched to the "personal" label') ? ev : null;
    });
    expect(events!.some((e) => e.title === 'You switched to the servers labeled "personal" and turned the others off')).toBe(true);
  });

  it("rejects an unknown label or action", async () => {
    expect((await t.api("POST", "/api/labels/apply", { label: "nope", action: "on" })).status).toBe(404);
    expect((await t.api("POST", "/api/labels/apply", { label: "work", action: "toggle" })).status).toBe(400);
    expect((await t.api("POST", "/api/labels/apply", { label: "", action: "on" })).status).toBe(400);
  });

  it("changing only labels or notes leaves a running server running", async () => {
    await waitFor(async () => (await server("music")).state === "connected" || null);
    const before = (await server("music")).connectedAt;
    await t.api("PUT", "/api/servers/music", { labels: ["personal", "fun"], notes: "Plays songs." });
    const after = await server("music");
    expect(after.state).toBe("connected");
    expect(after.connectedAt).toBe(before);
    expect(after.config.labels).toEqual(["personal", "fun"]);

    await t.api("PUT", "/api/servers/music", { args: [MOCK, "--changed"] });
    await waitFor(async () => {
      const s = await server("music");
      return (s.state === "connected" && s.connectedAt !== before) || null;
    });
  });
});
