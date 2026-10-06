import { describe, expect, it } from "vitest";

import {
  createDefaultInferenceEndpointResolver,
  InferenceConfigAdapterRegistry,
  projectHostedInferenceForAcpAgent,
  selectInferenceProtocol,
} from "@open-managed-agents/acp-runtime/inference";
import {
  codexInferenceAdapter,
  dshInferenceAdapter,
  piInferenceAdapter,
} from "../src/index.js";
import { assertNoSecretInFileContent } from "../src/helpers.js";

const proxy = {
  proxyBaseUrl: "https://api.openma.test/v1/oma/inference-proxy/sess_1",
  proxyToken: "work-token-value",
  proxyTokenEnvVar: "HOSTED_INFERENCE_TOKEN" as const,
};

const target = {
  wireModel: "deepseek-chat",
  provider: "deepseek",
  baseUrl: null,
};

const resolver = createDefaultInferenceEndpointResolver();

describe("harness inference adapters", () => {
  it("projects pi OpenAI-chat route through hosted proxy", () => {
    const endpoints = resolver.resolve(target);
    const { protocol, endpoint } = selectInferenceProtocol(piInferenceAdapter, endpoints);
    const plan = piInferenceAdapter.plan({
      agent: { id: "pi-acp", command: "pi-acp" },
      nativePath: "/native/pi",
      target,
      proxy,
      protocol,
      endpoint,
    });
    expect(plan.env.PI_ACP_MODEL).toBe("deepseek/deepseek-chat");
    expect(plan.files[0]?.content).toContain(
      "https://api.openma.test/v1/oma/inference-proxy/sess_1/openai/v1",
    );
    expect(plan.files[0]?.content).toContain("{env:HOSTED_INFERENCE_TOKEN}");
    assertNoSecretInFileContent(plan.files[0]!.content, proxy.proxyToken);
  });

  it("projects dsh Anthropic-messages route with native env vars", () => {
    const endpoints = resolver.resolve(target);
    const { protocol, endpoint } = selectInferenceProtocol(dshInferenceAdapter, endpoints);
    const plan = dshInferenceAdapter.plan({
      agent: { id: "deepseek-harness-acp", command: "dsh-acp" },
      nativePath: "/native/dsh",
      target,
      proxy,
      protocol,
      endpoint,
    });
    expect(plan.env.DEEPSEEK_BASE_URL).toBe(
      "https://api.openma.test/v1/oma/inference-proxy/sess_1/anthropic",
    );
    expect(plan.env.DEEPSEEK_API_KEY).toBe(proxy.proxyToken);
    expect(plan.env.DSH_MODEL).toBe("deepseek-chat");
    expect(plan.files).toHaveLength(0);
  });

  it("keeps proxy token out of codex config files", () => {
    const token = "sk-ant-req-v1.super-secret-work-token";
    const registry = new InferenceConfigAdapterRegistry();
    registry.register(codexInferenceAdapter);
    const result = projectHostedInferenceForAcpAgent({
      sessionId: "sess_1",
      gatewayBaseUrl: "https://api.openma.test",
      sessionsToken: token,
      env: { DEEPSEEK_API_KEY: "provider-secret" },
      agent: { id: "codex-acp", command: "codex-acp" },
      nativePath: "/tmp/native",
      target: { wireModel: "gpt-5", provider: "openai", baseUrl: null },
      adapterRegistry: registry,
      endpointResolver: createDefaultInferenceEndpointResolver(),
    });
    expect(result.files[0]?.content).toContain("env_key = \"HOSTED_INFERENCE_TOKEN\"");
    expect(result.files[0]?.content).not.toContain(token);
  });
});
