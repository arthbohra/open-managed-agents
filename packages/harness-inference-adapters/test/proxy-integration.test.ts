import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import { wireHostedInferenceForAcpLaunch } from "../src/wire.js";

async function withFakeUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected bound port");
  }
  try {
    await run(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("hosted inference adapter proxy paths", () => {
  it("maps pi and dsh plans to distinct protocol subpaths", async () => {
    const seen: string[] = [];
    await withFakeUpstream((req, res) => {
      seen.push(req.url ?? "");
      res.statusCode = 200;
      res.end("ok");
    }, async () => {
      const pi = wireHostedInferenceForAcpLaunch({
        sessionId: "sess_1",
        gatewayBaseUrl: "https://api.openma.test",
        sessionsToken: "work-token",
        env: {},
        agent: { id: "pi-acp", command: "pi-acp" },
        nativePath: "/native/pi",
        target: { wireModel: "deepseek-chat", provider: "deepseek", baseUrl: null },
      });
      const dsh = wireHostedInferenceForAcpLaunch({
        sessionId: "sess_1",
        gatewayBaseUrl: "https://api.openma.test",
        sessionsToken: "work-token",
        env: {},
        agent: { id: "dsh-acp", command: "dsh-acp" },
        nativePath: "/native/dsh",
        target: { wireModel: "deepseek-chat", provider: "deepseek", baseUrl: null },
      });
      const piBase = JSON.parse(pi.files[0]!.content).providers.deepseek.baseUrl;
      const dshBase = dsh.env.DEEPSEEK_BASE_URL;
      expect(piBase).toContain("/openai/v1");
      expect(dshBase).toContain("/anthropic");
      expect(piBase).not.toEqual(dshBase);
    });
    expect(seen).toEqual([]);
  });
});
