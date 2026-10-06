import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import {
  applyUpstreamCredentialsForProtocol,
  copyInboundHeadersForUpstream,
  forwardHostedInferenceRequest,
} from "@open-managed-agents/inference-proxy";
import { resolveProtocolEndpointsFromModelCard } from "@open-managed-agents/inference-proxy";

import { wireHostedInferenceForAcpLaunch } from "../src/wire.js";

async function withFakeUpstream(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (port: number) => Promise<void>,
): Promise<string[]> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
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
  return seen;
}

describe("hosted inference proxy integration", () => {
  it("routes pi openai and dsh anthropic subpaths to distinct upstream URLs", async () => {
    const endpoints = resolveProtocolEndpointsFromModelCard({
      providerId: "deepseek",
      baseUrl: null,
    });
    const pi = wireHostedInferenceForAcpLaunch({
      sessionId: "sess_1",
      gatewayBaseUrl: "https://api.openma.test",
      sessionsToken: "work-token",
      env: {},
      agent: { id: "pi-acp", command: "pi-acp" },
      nativePath: "/native/pi",
      model: { wireModel: "deepseek-chat", providerId: "deepseek", baseUrl: null },
    });
    const dsh = wireHostedInferenceForAcpLaunch({
      sessionId: "sess_1",
      gatewayBaseUrl: "https://api.openma.test",
      sessionsToken: "work-token",
      env: {},
      agent: { id: "dsh-acp", command: "dsh-acp" },
      nativePath: "/native/dsh",
      model: { wireModel: "deepseek-chat", providerId: "deepseek", baseUrl: null },
    });
    const piBase = JSON.parse(pi.files[0]!.content).providers.deepseek.baseUrl;
    expect(piBase).toContain("/openai/v1");
    expect(dsh.env.DEEPSEEK_BASE_URL).toContain("/anthropic");

    const seen = await withFakeUpstream((req, res) => {
      res.statusCode = 200;
      res.end("ok");
    }, async (port) => {
      const upstreamBase = `http://127.0.0.1:${port}`;
      const patched = endpoints.map((endpoint) => ({
        ...endpoint,
        upstreamBaseUrl: endpoint.protocol === "openai-chat"
          ? upstreamBase
          : `${upstreamBase}/anthropic`,
      }));
      const upstream = {
        wireModel: "deepseek-chat",
        apiKey: "upstream-secret",
        provider: "deepseek",
        providerId: "deepseek",
        protocolEndpoints: patched,
      };
      await forwardHostedInferenceRequest({
        upstream,
        method: "POST",
        subPath: "openai/v1/chat/completions",
        inboundHeaders: new Headers({ authorization: "Bearer work-token" }),
        body: new TextEncoder().encode("{}").buffer,
        fetcher: fetch,
      });
      await forwardHostedInferenceRequest({
        upstream,
        method: "POST",
        subPath: "anthropic/v1/messages",
        inboundHeaders: new Headers({ "x-api-key": "work-token" }),
        body: new TextEncoder().encode("{}").buffer,
        fetcher: fetch,
      });
    });
    expect(seen).toEqual([
      "POST /v1/chat/completions",
      "POST /anthropic/v1/messages",
    ]);
  });

  it("applies protocol-specific upstream auth headers", () => {
    const openai = new Headers();
    applyUpstreamCredentialsForProtocol(openai, "openai-chat", "key");
    expect(openai.get("authorization")).toBe("Bearer key");

    const anthropic = new Headers();
    applyUpstreamCredentialsForProtocol(anthropic, "anthropic-messages", "key");
    expect(anthropic.get("x-api-key")).toBe("key");
    expect(anthropic.has("authorization")).toBe(false);

    const inbound = new Headers({
      authorization: "Bearer sandbox",
      "x-api-key": "sandbox",
    });
    const stripped = copyInboundHeadersForUpstream(inbound);
    expect(stripped.has("authorization")).toBe(false);
    expect(stripped.has("x-api-key")).toBe(false);
  });
});
