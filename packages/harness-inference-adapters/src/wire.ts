import {
  createDefaultInferenceEndpointResolver,
  projectHostedInferenceForAcpAgent,
  type InferenceTargetDescriptor,
} from "@open-managed-agents/acp-runtime/inference";
import type { AcpStatefulAgentSpec } from "@open-managed-agents/acp-runtime/native-state";

import { createDefaultHarnessInferenceAdapterRegistry } from "./registry.js";

const defaultRegistry = createDefaultHarnessInferenceAdapterRegistry();
const defaultEndpointResolver = createDefaultInferenceEndpointResolver();

export interface WireHostedInferenceInput {
  sessionId: string;
  gatewayBaseUrl?: string;
  sessionsToken?: string;
  env: Record<string, string | undefined>;
  agent: AcpStatefulAgentSpec;
  nativePath: string;
  target: InferenceTargetDescriptor;
  enableProxy?: boolean;
}

export function wireHostedInferenceForAcpLaunch(
  input: WireHostedInferenceInput,
) {
  return projectHostedInferenceForAcpAgent({
    ...input,
    adapterRegistry: defaultRegistry,
    endpointResolver: defaultEndpointResolver,
  });
}
