import { afterEach, describe, expect, it, vi } from "vitest";
import { notify } from "../src/system.js";

describe("notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MCP_HUB_NOTIFY;
  });

  it("hands the notification to the desktop app instead of the OS when asked to", () => {
    process.env.MCP_HUB_NOTIFY = "stdout";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    notify("MCP Hub", "Claude wants to use MCP Hub.");
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0]![0]))).toEqual({ event: "notify", title: "MCP Hub", message: "Claude wants to use MCP Hub." });
  });
});
