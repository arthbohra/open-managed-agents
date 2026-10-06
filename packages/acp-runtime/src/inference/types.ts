import type { AcpStatefulAgentSpec } from "../native-state.js";

/** Closed set of wire protocols supported by hosted inference routing. */
export type InferenceWireProtocol =
  | "anthropic-messages"
  | "openai-chat"
  | "openai-responses"
  | "gemini";

export interface InferenceProtocolEndpoint {
  protocol: InferenceWireProtocol;
  /** Suffix path on the session hosted-inference base URL (no leading slash). */
  proxyPathSegment: string;
}

/** Resolved model target available when an ACP child starts. */
export interface InferenceTargetDescriptor {
  wireModel: string;
  provider: string;
  baseUrl: string | null;
  /** When set, overrides provider catalog resolution. */
  protocolEndpoints?: readonly InferenceProtocolEndpoint[];
}

export interface HostedInferenceProxyTarget {
  /** Session-scoped gateway base (no trailing slash). */
  proxyBaseUrl: string;
  /** Short-lived Work capability; injected into process env only, never config files. */
  proxyToken: string;
  proxyTokenEnvVar: "HOSTED_INFERENCE_TOKEN";
}

export interface InferenceConfigFile {
  /** Absolute path in the sandbox (under native state root). */
  path: string;
  content: string;
}

export interface InferenceConfigPlan {
  protocol: InferenceWireProtocol;
  env: Record<string, string>;
  unsetEnv: readonly string[];
  args?: readonly string[];
  files: readonly InferenceConfigFile[];
}

export interface InferenceConfigPlanContext {
  agent: AcpStatefulAgentSpec;
  nativePath: string;
  target: InferenceTargetDescriptor;
  proxy: HostedInferenceProxyTarget;
  protocol: InferenceWireProtocol;
  endpoint: InferenceProtocolEndpoint;
}

export interface InferenceConfigAdapter {
  readonly id: string;
  matches(agent: AcpStatefulAgentSpec): boolean;
  readonly supportedProtocols: readonly InferenceWireProtocol[];
  plan(context: InferenceConfigPlanContext): InferenceConfigPlan;
}
