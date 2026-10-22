import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChildRegistry, descendantsOf, stopLeftovers } from "../src/children.js";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 60 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

describe("leftover MCP servers from a hub that died", () => {
  const procs: ChildProcess[] = [];
  const idle = (extra = ""): ChildProcess => {
    const p = spawn(process.execPath, ["-e", `${extra}setInterval(() => {}, 1000)`], { stdio: "ignore" });
    procs.push(p);
    return p;
  };
  afterEach(() => {
    for (const p of procs.splice(0)) p.kill("SIGKILL");
  });
  const registry = () => {
    const file = join(mkdtempSync(join(tmpdir(), "mcp-hub-children-")), "children.json");
    return { file, reg: new ChildRegistry(file) };
  };

  it("stops a recorded server (and what it started) on the next start", async () => {
    const { file, reg } = registry();
    // A wrapper that starts the real server, like npx does.
    const wrapper = idle(`require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`);
    await new Promise((r) => setTimeout(r, 300));
    reg.add(wrapper.pid!, process.execPath);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual([{ pid: wrapper.pid, command: process.execPath }]);
    expect(await reg.sweep(500)).toBe(2);
    expect(await waitDead(wrapper.pid!)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("leaves alone a pid that now belongs to something else", async () => {
    const { reg } = registry();
    const other = idle();
    reg.add(other.pid!, "/not/the/server/we/started");
    expect(await reg.sweep(200)).toBe(0);
    expect(alive(other.pid!)).toBe(true);
  });

  it("finds what a server started and stops it after the server is gone", async () => {
    const wrapper = idle(`require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`);
    await new Promise((r) => setTimeout(r, 300));
    const family = await descendantsOf(wrapper.pid!);
    expect(family).toHaveLength(1);
    wrapper.kill("SIGKILL"); // the real server is now an orphan
    await waitDead(wrapper.pid!);
    expect(alive(family[0]!)).toBe(true);
    await stopLeftovers(family, 500);
    expect(await waitDead(family[0]!)).toBe(true);
  });

  it("forgets servers that exited normally", async () => {
    const { file, reg } = registry();
    const p = idle();
    reg.add(p.pid!, process.execPath);
    p.kill("SIGKILL");
    await waitDead(p.pid!);
    reg.prune();
    expect(existsSync(file)).toBe(false);
  });
});
