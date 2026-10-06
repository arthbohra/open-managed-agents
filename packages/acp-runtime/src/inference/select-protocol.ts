import { InferenceProtocolUnsupportedError } from "./errors.js";
import type {
  InferenceConfigAdapter,
  InferenceProtocolEndpoint,
  InferenceWireProtocol,
} from "./types.js";

export function selectInferenceProtocol(
  adapter: InferenceConfigAdapter,
  endpoints: readonly InferenceProtocolEndpoint[],
): { protocol: InferenceWireProtocol; endpoint: InferenceProtocolEndpoint } {
  const supported = new Set(adapter.supportedProtocols);
  const endpoint = endpoints.find((candidate) => supported.has(candidate.protocol));
  if (!endpoint) {
    throw new InferenceProtocolUnsupportedError({
      adapterId: adapter.id,
      supported: adapter.supportedProtocols,
      available: endpoints.map((item) => item.protocol),
    });
  }
  return { protocol: endpoint.protocol, endpoint };
}
