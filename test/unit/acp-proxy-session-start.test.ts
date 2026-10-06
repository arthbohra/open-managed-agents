import { describe, expect, it, vi } from "vitest";
import { AcpProxyHarness } from "../../apps/agent/src/harness/acp-proxy-loop";
import type { HarnessContext } from "../../apps/agent/src/harness/interface";
import {
  augmentAcpUserPrompt,
  defaultAcpBundleRoot,
  resolveRepositoryLocalPath,
} from "../../apps/agent/src/harness/acp-proxy-delivery";

class Socket {
  listeners = new Map<string, Array<(event: unknown) => void>>();
  sent: Array<Record<string, unknown>> = [];
  onSend: (frame: Record<string, unknown>) => void = () => {};
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]);
  }
  receive(frame: unknown) {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(frame) });
    }
  }
  close() {
    for (const listener of this.listeners.get("close") ?? []) listener({});
  }
  send(raw: string) {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(frame);
    queueMicrotask(() => this.onSend(frame));
  }
}

describe("resolveRepositoryLocalPath", () => {
  it("prefers local_path over sandbox mount_path", () => {
    expect(
      resolveRepositoryLocalPath([
        {
          type: "github_repository",
          resource: {
            local_path: "/home/user/project",
            mount_path: "/workspace/project",
          },
        },
      ]),
    ).toBe("/home/user/project");
  });

  it("uses non-/workspace mount_path when local_path is absent", () => {
    expect(
      resolveRepositoryLocalPath([
        {
          type: "github_repository",
          resource: { mount_path: "/Users/alice/repo" },
        },
      ]),
    ).toBe("/Users/alice/repo");
  });
});

describe("augmentAcpUserPrompt", () => {
  it("points the agent at the daemon scratch bundle directory", () => {
    const sessionId = "sess-oma3b-test";
    const prompt = augmentAcpUserPrompt("do work", {
      sessionId,
      systemPrompt: "You are the OMA agent.",
      projectCwd: "/home/user/project",
    });
    const bundleRoot = defaultAcpBundleRoot(sessionId);
    expect(prompt).toContain(bundleRoot);
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("You are the OMA agent.");
    expect(prompt).toContain("do work");
    expect(prompt).not.toContain("/home/user/project/AGENTS.md");
  });
});

describe("AcpProxyHarness session.start cwd", () => {
  it("forwards repository local path on session.start and delivers platform context via prompt", async () => {
    const events: Array<Record<string, unknown>> = [];
    let socket: Socket | undefined;
    const context = {
      agent: {
        model: "test-model",
        runtime_binding: { runtime_id: "runner", acp_agent_id: "codex-acp" },
      },
      session_id: "remote-session",
      tenant_id: "team",
      acpSessionStartCwd: "/data/myproject",
      systemPrompt: "System from OMA.",
      userMessage: { type: "user.message", content: [{ type: "text", text: "go" }] },
      env: {
        RUNTIME_ROOM: {
          idFromName: (id: string) => id,
          get: () => ({
            fetch: async () => {
              socket = new Socket();
              socket.onSend = (frame) => {
                if (frame.type === "session.start") {
                  socket!.receive({ type: "session.ready", acp_session_id: "native" });
                }
                if (frame.type === "session.prompt") {
                  socket!.receive({
                    type: "session.complete",
                    turn_id: frame.turn_id,
                  });
                }
              };
              const ws = socket as Socket & { accept: () => void };
              ws.accept = () => {
                socket!.receive({ type: "attached", daemon_online: true });
              };
              return { status: 101, webSocket: ws };
            },
          }),
        },
      },
      runtime: {
        history: { getEvents: () => events },
        broadcast: (event: Record<string, unknown>) => events.push(event),
        pendingConfirmations: [],
        broadcastStreamStart: async () => {},
        broadcastChunk: async () => {},
        broadcastStreamEnd: async () => {},
        broadcastThinkingStart: async () => {},
        broadcastThinkingChunk: async () => {},
        broadcastThinkingEnd: async () => {},
      },
    } as unknown as HarnessContext;

    await new AcpProxyHarness().run(context);

    const start = socket!.sent.find((frame) => frame.type === "session.start");
    expect(start).toMatchObject({
      type: "session.start",
      agent_id: "codex-acp",
      cwd: "/data/myproject",
    });

    const prompt = socket!.sent.find((frame) => frame.type === "session.prompt");
    expect(String(prompt?.text)).toContain("<openma-acp-platform>");
    expect(String(prompt?.text)).toContain("System from OMA.");
    expect(String(prompt?.text)).toContain("go");
    expect(String(prompt?.text)).toContain(defaultAcpBundleRoot("remote-session"));
  });
});
