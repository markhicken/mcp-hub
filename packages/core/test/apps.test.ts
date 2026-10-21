import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientGate, type ProcInfo } from "../src/clients.js";
import { startHub } from "./helpers.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "mcp-hub-apps-"));
  const file = join(d, "apps.json");
  dirs.push(file);
  return file;
};
afterEach(() => {
  for (const file of dirs.splice(0)) rmSync(dirname(file), { recursive: true, force: true });
});

/** A fake process table: each app launch is `{ app pid, path }`; shims hang off it. */
function launch(appPid: number, command: string) {
  const procs = new Map<number, ProcInfo>([[appPid, { pid: appPid, ppid: 1, started: `t${appPid}`, command }]]);
  const lookup = async (pid: number) => procs.get(pid) ?? { pid, ppid: appPid, started: `s${pid}`, command: "shim" };
  return { lookup, args: async () => "" };
}

const APP = "/Applications/Fake Client.app/Contents/MacOS/Fake Client";
const mk = (file: string, p: ReturnType<typeof launch>, signer = async () => "") => new ClientGate({ file, lookup: p.lookup, args: p.args, signer, waitMs: 40, alive: () => true });

describe("remembered apps", () => {
  it("applies a saved choice when the same app comes back, without asking", async () => {
    const file = tmp();
    const first = mk(file, launch(10, APP));
    const asked: string[] = [];
    first.on("pending", (c) => asked.push(c.name));
    const pending = first.authorize(21, "a");
    await new Promise((r) => setTimeout(r, 10));
    first.decide(first.list()[0]!.id, true, ["a"]);
    expect((await pending).status).toBe("allowed");
    expect(asked).toEqual(["Fake Client"]);
    first.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // A new copy of the app (different pid) and a new hub: nothing is asked.
    const second = mk(file, launch(77, APP));
    const restored: string[] = [];
    const prompts: string[] = [];
    second.on("restored", (c) => restored.push(c.name));
    second.on("pending", (c) => prompts.push(c.name));
    expect((await second.authorize(81, "a")).status).toBe("allowed");
    expect((await second.authorize(82, "b")).status).toBe("denied");
    expect(restored).toEqual(["Fake Client"]);
    expect(prompts).toEqual([]);
    expect(second.list()[0]).toMatchObject({ remembered: true, running: true, allowed: ["a"] });
    second.close();
  });

  it("does not save a choice made without remember, and forgets an earlier saved one", async () => {
    const file = tmp();
    const g = mk(file, launch(10, APP));
    void g.authorize(21, "a");
    await new Promise((r) => setTimeout(r, 10));
    const id = g.list()[0]!.id;
    g.decide(id, true, null, false);
    expect(g.list()[0]).toMatchObject({ status: "allowed", remembered: false });
    g.close();
    const again = mk(file, launch(55, APP));
    const v = again.authorize(31, "a");
    await new Promise((r) => setTimeout(r, 10));
    expect(again.list()[0]!.status).toBe("pending");
    again.decide(again.list()[0]!.id, true);
    await v;
    again.decide(again.list()[0]!.id, true, null, false);
    again.close();
    const third = mk(file, launch(56, APP));
    void third.authorize(41, "a");
    await new Promise((r) => setTimeout(r, 10));
    expect(third.list()[0]!.status).toBe("pending");
    third.close();
  });

  it("asks again when the app at that path is signed differently", async () => {
    const file = tmp();
    const g = mk(file, launch(10, APP), async () => "com.fake|TEAM1");
    void g.authorize(21, "a");
    await new Promise((r) => setTimeout(r, 10));
    g.decide(g.list()[0]!.id, true);
    g.close();

    const imposter = mk(file, launch(60, APP), async () => "com.fake|OTHERTEAM");
    const events: string[] = [];
    imposter.on("mismatch", () => events.push("mismatch"));
    imposter.on("pending", () => events.push("pending"));
    void imposter.authorize(61, "a");
    await new Promise((r) => setTimeout(r, 10));
    expect(imposter.list().find((c) => c.running)).toMatchObject({ status: "pending", remembered: false });
    expect(events).toEqual(["mismatch", "pending"]);
    imposter.close();

    const real = mk(file, launch(62, APP), async () => "com.fake|TEAM1");
    expect((await real.authorize(63, "a")).status).toBe("allowed");
    real.close();
  });

  it("lists a remembered app that isn't running, and lets its access be changed or removed", async () => {
    const file = tmp();
    const g = mk(file, launch(10, APP));
    void g.authorize(21, "a");
    await new Promise((r) => setTimeout(r, 10));
    g.decide(g.list()[0]!.id, true);
    g.close();

    const hub = new ClientGate({ file, lookup: async () => null, waitMs: 10 });
    const [idle] = hub.list();
    expect(idle).toMatchObject({ name: "Fake Client", status: "allowed", running: false, remembered: true, path: "/Applications/Fake Client.app" });
    expect(hub.decide(idle!.id, true, ["only-this"])).toBe(true);
    expect(hub.list()[0]!.allowed).toEqual(["only-this"]);
    expect(hub.decide(idle!.id, false)).toBe(true);
    expect(hub.list()[0]).toMatchObject({ status: "denied", running: false });

    const removed: string[] = [];
    hub.on("removed", (c) => removed.push(c.name));
    expect(hub.remove(idle!.id)).toBe(true);
    expect(hub.list()).toEqual([]);
    expect(removed).toEqual(["Fake Client"]);
    expect(hub.remove(idle!.id)).toBe(false);
    hub.close();
    expect(JSON.parse(readFileSync(file, "utf-8")).apps).toEqual([]);
  });

  it("removing a running app makes it ask again, and tells the hub which sessions to drop", async () => {
    const file = tmp();
    const g = mk(file, launch(10, APP));
    void g.authorize(21, "a");
    await new Promise((r) => setTimeout(r, 10));
    const id = g.list()[0]!.id;
    g.decide(id, true);
    let dropped: string[] = [];
    g.on("removed", (_c, ids) => (dropped = ids));
    expect(g.remove(id)).toBe(true);
    expect(dropped).toEqual([id]);
    expect(g.list()).toEqual([]);
    void g.authorize(22, "a");
    await new Promise((r) => setTimeout(r, 10));
    expect(g.list()[0]).toMatchObject({ status: "pending", remembered: false });
    g.close();
  });

  it("ignores an unreadable file and keeps going", () => {
    const file = tmp();
    writeFileSync(file, "{ not json");
    const g = new ClientGate({ file, lookup: async () => null });
    expect(g.list()).toEqual([]);
    g.close();
  });
});

describe("remembered apps over the API", () => {
  it("validates remember, and returns 404 for an unknown app", async () => {
    const t = await startHub();
    try {
      expect((await t.api("POST", "/api/clients/nope/decision", { allow: true, remember: "yes" })).status).toBe(400);
      expect((await t.api("POST", "/api/clients/nope/decision", { allow: true })).status).toBe(404);
      expect((await t.api("DELETE", "/api/clients/nope")).status).toBe(404);
      expect((await t.api("DELETE", "/api/clients/saved%3Aapp%3A%2Fnowhere")).status).toBe(404);
    } finally {
      await t.stop();
    }
  });
});
