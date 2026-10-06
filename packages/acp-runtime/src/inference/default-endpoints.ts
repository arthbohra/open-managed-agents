import type { InferenceEndpointContributor } from "./endpoint-resolver.js";

const OPENAI_CHAT = {
  protocol: "openai-chat" as const,
  proxyPathSegment: "openai/v1",
};

const ANTHROPIC_MESSAGES = {
  protocol: "anthropic-messages" as const,
  proxyPathSegment: "anthropic",
};

const OPENAI_RESPONSES = {
  protocol: "openai-responses" as const,
  proxyPathSegment: "openai/v1",
};

const GEMINI = {
  protocol: "gemini" as const,
  proxyPathSegment: "gemini",
};

/** Provider catalog for inferring protocol endpoints from model cards. */
export const DEFAULT_INFERENCE_ENDPOINT_CONTRIBUTORS: readonly InferenceEndpointContributor[] = [
  {
    providerIds: ["deepseek"],
    endpoints: () => [OPENAI_CHAT, ANTHROPIC_MESSAGES],
  },
  {
    providerIds: ["anthropic", "ant", "ant-compatible"],
    endpoints: () => [ANTHROPIC_MESSAGES],
  },
  {
    providerIds: ["openai", "oai", "oai-compatible"],
    endpoints: () => [OPENAI_CHAT, OPENAI_RESPONSES],
  },
  {
    providerIds: ["google", "gemini"],
    endpoints: () => [GEMINI],
  },
];

import { InferenceEndpointResolver } from "./endpoint-resolver.js";

export function createDefaultInferenceEndpointResolver(): InferenceEndpointResolver {
  const resolver = new InferenceEndpointResolver();
  for (const contributor of DEFAULT_INFERENCE_ENDPOINT_CONTRIBUTORS) {
    resolver.register(contributor);
  }
  return resolver;
}
