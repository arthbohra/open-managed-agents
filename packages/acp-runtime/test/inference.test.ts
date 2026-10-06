import { describe, expect, it } from "vitest";

import type { InferenceConfigAdapter } from "../src/inference/types.js";
import {
  createDefaultInferenceEndpointResolver,
  InferenceProtocolUnsupportedError,
  selectInferenceProtocol,
} from "../src/inference/index.js";

const codexStubAdapter: InferenceConfigAdapter = {
  id: "codex",
  supportedProtocols: ["openai-responses"],
  matches: () => true,
  plan: () => ({
    protocol: "openai-responses",
    env: {},
    unsetEnv: [],
    files: [],
  }),
};

describe("inference endpoint resolver", () => {
  const resolver = createDefaultInferenceEndpointResolver();

  it("exposes DeepSeek dual-protocol endpoints", () => {
    const endpoints = resolver.resolve({
      wireModel: "deepseek-chat",
      provider: "deepseek",
      baseUrl: null,
    });
    expect(endpoints.map((item) => item.protocol).sort()).toEqual([
      "anthropic-messages",
      "openai-chat",
    ]);
  });

  it("fails fast when codex requires responses but DeepSeek lacks it", () => {
    const endpoints = resolver.resolve({
      wireModel: "deepseek-chat",
      provider: "deepseek",
      baseUrl: null,
    });
    expect(() => selectInferenceProtocol(codexStubAdapter, endpoints)).toThrow(
      InferenceProtocolUnsupportedError,
    );
  });
});
