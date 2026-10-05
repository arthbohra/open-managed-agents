import { describe, expect, it, vi } from "vitest";

import {
  applyHostedInferenceToAgentEnv,
  buildHostedInferenceBaseUrl,
  forwardHostedInferenceRequest,
  resolveUpstreamInferenceUrl,
} from "../src/index";

describe("hosted inference proxy helpers", () => {
  it("builds a session-scoped gateway URL on the OpenMA origin", () => {
    expect(buildHostedInferenceBaseUrl("https://api.openma.test/v1/", "session/01")).toBe(
      "https://api.openma.test/v1/oma/inference-proxy/session%2F01",
    );
  });

  it("strips provider secrets and injects hosted inference env", () => {
    const env = applyHostedInferenceToAgentEnv({
      sessionId: "sess_1",
      env: {
        DEEPSEEK_API_KEY: "secret",
        MODE: "test",
      },
      capability: {
        gatewayBaseUrl: "https://api.openma.test",
        sessionsToken: "sk-ant-req-v1.token",
      },
    });
    expect(env).toEqual({
      MODE: "test",
      HOSTED_INFERENCE_URL: "https://api.openma.test/v1/oma/inference-proxy/sess_1",
      HOSTED_INFERENCE_TOKEN: "sk-ant-req-v1.token",
    });
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it("resolves upstream OpenAI-compatible paths without duplicating /v1", () => {
    expect(resolveUpstreamInferenceUrl({
      subPath: "v1/chat/completions",
      baseURL: "https://api.deepseek.com/v1",
      provider: "deepseek",
    })).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(resolveUpstreamInferenceUrl({
      subPath: "v1/chat/completions",
      provider: "deepseek",
    })).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("forwards with the resolved model-card bearer", async () => {
    const fetcher = vi.fn(async () => new Response("ok", { status: 200 }));
    const response = await forwardHostedInferenceRequest({
      upstream: {
        wireModel: "deepseek-chat",
        apiKey: "upstream-key",
        baseURL: "https://api.deepseek.com",
        provider: "deepseek",
      },
      method: "POST",
      subPath: "v1/chat/completions",
      inboundHeaders: new Headers({
        authorization: "Bearer sk-ant-req-v1.sandbox",
        "content-type": "application/json",
      }),
      body: new TextEncoder().encode("{}").buffer,
      fetcher,
    });
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect((init.headers as Headers).get("authorization")).toBe("Bearer upstream-key");
  });
});
