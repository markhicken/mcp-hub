import { describe, expect, it } from "vitest";
import { colorFor, formatBytes, isCredentialRef, parseServerJson, refParts, slugify, splitArgs, timeAgo, timeUntil } from "./lib";

describe("formatBytes", () => {
  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("timeAgo", () => {
  it("is relative", () => {
    const now = 1_000_000_000;
    expect(timeAgo(now - 2000, now)).toBe("just now");
    expect(timeAgo(now - 90_000, now)).toBe("1m ago");
    expect(timeAgo(null)).toBe("never");
  });
});

describe("timeUntil", () => {
  it("looks forward", () => {
    const now = 1_000_000_000;
    expect(timeUntil(now + 30_000, now)).toBe("in 30s");
    expect(timeUntil(now + 3_540_000, now)).toBe("in 59m");
    expect(timeUntil(now - 1000, now)).toBe("now");
  });
});

describe("colorFor", () => {
  it("is stable", () => expect(colorFor("github")).toBe(colorFor("github")));
});

describe("slugify / splitArgs", () => {
  it("slugifies", () => expect(slugify("My Cool Server!")).toBe("my-cool-server"));
  it("splits quoted args", () => expect(splitArgs(`-y "@scope/pkg name" 'a b'`)).toEqual(["-y", "@scope/pkg name", "a b"]));
});

describe("parseServerJson", () => {
  it("parses the mcpServers form", () => {
    const r = parseServerJson(JSON.stringify({ mcpServers: { gh: { command: "npx", args: ["-y", "x"], env: { A: "1" } }, remote: { url: "https://x/mcp" } } }));
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ name: "gh", transport: "stdio", command: "npx" });
    expect(r[1]).toMatchObject({ name: "remote", transport: "http", url: "https://x/mcp" });
  });
  it("parses a single object", () => expect(parseServerJson('{"command":"node","args":["a.js"]}')[0]).toMatchObject({ transport: "stdio", command: "node" }));
  it("rejects junk", () => {
    expect(() => parseServerJson("nope")).toThrow(/valid JSON/);
    expect(() => parseServerJson("{}")).toThrow(/command/);
  });
});

describe("isCredentialRef", () => {
  it("detects templates", () => {
    expect(isCredentialRef("{{op://v/i/f}}")).toBe(true);
    expect(isCredentialRef("op://v/i/f")).toBe(true);
    expect(isCredentialRef("plain")).toBe(false);
  });
});

describe("refParts", () => {
  it("marks only the references inside a larger value", () => {
    expect(refParts("https://x/mcp?api_key={{op://V/I/f}}&paper=true")).toEqual([
      { text: "https://x/mcp?api_key=", ref: false },
      { text: "{{op://V/I/f}}", ref: true },
      { text: "&paper=true", ref: false },
    ]);
    expect(refParts("Bearer {{ secret://t }}").map((p) => p.ref)).toEqual([false, true]);
    expect(refParts("op://V/I/f")).toEqual([{ text: "op://V/I/f", ref: true }]);
    expect(refParts("{{not a ref}} plain")).toEqual([{ text: "{{not a ref}} plain", ref: false }]);
  });
});
