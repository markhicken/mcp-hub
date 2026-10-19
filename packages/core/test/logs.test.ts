import { describe, expect, it } from "vitest";
import { LogBuffer } from "../src/logs.js";

describe("log buffer", () => {
  it("masks resolved secrets before storing lines", () => {
    const logs = new LogBuffer();
    logs.setSecrets(["s3cr3t-token", "ab"]);
    logs.add("stderr", "calling api with s3cr3t-token now\nsecond line s3cr3t-token");
    const lines = logs.tail().map((l) => l.text);
    expect(lines).toEqual(["calling api with ••• now", "second line •••"]);
    expect(JSON.stringify(logs.tail())).not.toContain("s3cr3t-token");
  });

  it("ignores very short secrets so ordinary words are not masked", () => {
    const logs = new LogBuffer();
    logs.setSecrets(["ab"]);
    logs.add("info", "about to run");
    expect(logs.tail()[0]!.text).toBe("about to run");
  });

  it("keeps only the most recent lines", () => {
    const logs = new LogBuffer(3);
    for (let i = 0; i < 10; i++) logs.add("info", `line ${i}`);
    expect(logs.tail().map((l) => l.text)).toEqual(["line 7", "line 8", "line 9"]);
  });
});
