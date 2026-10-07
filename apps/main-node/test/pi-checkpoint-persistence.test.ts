import { describe, expect, it } from "vitest";
import { NodeHarnessRuntime } from "../src/lib/node-harness-runtime";

describe("Pi checkpoint persistence", () => {
  it("does not acknowledge a failed checkpoint or write later events past it", async () => {
    let attempts = 0;
    const runtime = new NodeHarnessRuntime({
      sessionId: "session-test",
      log: {
        appendAsync: async () => {
          attempts++;
          throw new Error("Checkpoint storage unavailable");
        },
      },
      hub: { publish: () => { throw new Error("Uncommitted event published"); } },
      sandbox: {},
    } as unknown as ConstructorParameters<typeof NodeHarnessRuntime>[0]);

    runtime.broadcast({ type: "agent.thread_context_compacted" } as never);
    await expect(runtime.drain()).rejects.toThrow("Checkpoint storage unavailable");
    runtime.broadcast({ type: "agent.message" } as never);
    await expect(runtime.drain()).rejects.toThrow("Checkpoint storage unavailable");
    expect(attempts).toBe(1);
  });
});
