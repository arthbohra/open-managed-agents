import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { closeInterruptedToolCalls, createReplayedHostedPiSession } from "../src/harness/pi-session";
import { encodePiContext, restorePiContext } from "../src/harness/pi-context";

describe("stock Pi session recovery", () => {
  it("requires durable tool results before replaying a completed operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openma-pi-replay-test-"));
    try {
      const modelRuntime = await ModelRuntime.create({
        authPath: join(directory, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(directory, "models.json"),
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
      modelRuntime.registerNativeProvider(faux.provider);
      const options = {
        cwd: "/workspace",
        agentDir: directory,
        modelRuntime,
        model: faux.getModel(),
        systemPrompt: "Do not repeat saved operations.",
        tools: [],
      };
      const call = fauxAssistantMessage(
        [fauxToolCall("write", {}, { id: "saved-write" })],
        { stopReason: "toolUse" },
      );
      await expect(createReplayedHostedPiSession({
        ...options,
        history: [call],
      })).rejects.toThrow("Await durable tool results");
      const receipt = {
        role: "toolResult" as const,
        toolCallId: "saved-write",
        toolName: "write",
        content: [{ type: "text" as const, text: "Saved successfully" }],
        isError: false,
        timestamp: Date.now(),
      };
      const { session } = await createReplayedHostedPiSession({
        ...options,
        history: [call, receipt],
      });
      try {
        expect(JSON.stringify(session.messages)).toContain("Saved successfully");
      } finally {
        session.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers the last checkpoint and closes only interrupted older tools", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openma-pi-checkpoint-test-"));
    try {
      const checkpoint = encodePiContext([{
        role: "user", content: "Older evidence", timestamp: 1,
      }]);
      const restored = await restorePiContext(checkpoint, "/workspace", directory);
      expect(JSON.stringify(restored.buildSessionContext().messages)).toContain("Older evidence");
      const interrupted = fauxAssistantMessage(
        [fauxToolCall("bash", {}, { id: "interrupted" })],
        { stopReason: "toolUse" },
      );
      const closed = closeInterruptedToolCalls([
        interrupted,
        { role: "user", content: "What happened?", timestamp: 2 },
      ]);
      expect(closed.map((message) => message.role)).toEqual([
        "assistant", "toolResult", "user",
      ]);
      expect(JSON.stringify(closed)).toContain("outcome is unknown");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
