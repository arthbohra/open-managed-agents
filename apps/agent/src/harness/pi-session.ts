import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  convertToLlm,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ToolDefinition,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { restorePiContext } from "./pi-context";

const interruptedToolResult =
  "This tool call was interrupted before its result was saved. The outcome is unknown: it may not have run, may have partly run, or may have completed. Inspect current state before relying on it.";

/**
 * A later user message proves the earlier turn ended, so tool calls it left
 * without results (a user interrupt or aborted turn) can no longer complete.
 * Close each with an explicit unknown-outcome result so replay can continue;
 * calls with no later user message stay open for their durable results.
 * A result recorded after that user message (an aborted tool settling late)
 * replaces its placeholder in place, so replay never sees it unmatched.
 */
export function closeInterruptedToolCalls(
  messages: readonly Message[],
): Message[] {
  const closed: Message[] = [];
  const pending = new Map<string, string>();
  const placeholders = new Map<string, number>();
  for (const message of messages) {
    if (message.role === "user") {
      for (const [toolCallId, toolName] of pending) {
        placeholders.set(toolCallId, closed.length);
        closed.push({
          role: "toolResult",
          toolCallId,
          toolName,
          content: [{ type: "text", text: interruptedToolResult }],
          isError: true,
          timestamp: message.timestamp,
        });
      }
      pending.clear();
    } else if (message.role === "assistant") {
      for (const part of message.content)
        if (part.type === "toolCall") pending.set(part.id, part.name);
    } else if (message.role === "toolResult") {
      const placeholder = placeholders.get(message.toolCallId);
      if (placeholder !== undefined) {
        placeholders.delete(message.toolCallId);
        closed[placeholder] = message;
        continue;
      }
      pending.delete(message.toolCallId);
    }
    closed.push(message);
  }
  return closed;
}

export async function createReplayedHostedPiSession(
  options: Omit<HostedPiSessionOptions, "sessionManager"> & {
    history: readonly Message[];
    checkpoint?: string;
  },
): Promise<CreateAgentSessionResult> {
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  const sessionManager = await restorePiContext(
    options.checkpoint,
    options.cwd,
    options.agentDir,
  );
  for (const message of [
    ...convertToLlm(sessionManager.buildSessionContext().messages),
    ...options.history,
  ]) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        if (seen.has(part.id))
          throw new Error("Cannot recover duplicate tool call IDs");
        seen.add(part.id);
        pending.set(part.id, part.name);
      }
    } else if (message.role === "toolResult") {
      if (pending.get(message.toolCallId) !== message.toolName)
        throw new Error("Cannot recover an unmatched tool result");
      pending.delete(message.toolCallId);
    }
  }
  if (pending.size > 0)
    throw new Error("Await durable tool results before recovering the session");
  for (const message of options.history) sessionManager.appendMessage(message);
  return createHostedPiSession({ ...options, sessionManager });
}

export interface HostedPiSessionOptions {
  cwd: string;
  agentDir: string;
  systemPrompt: string;
  model: NonNullable<CreateAgentSessionOptions["model"]>;
  modelRuntime: NonNullable<CreateAgentSessionOptions["modelRuntime"]>;
  sessionManager: NonNullable<CreateAgentSessionOptions["sessionManager"]>;
  tools: ToolDefinition[];
  thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
  hasPendingConfirmations?: () => boolean;
  compactionEnabled?: boolean;
  onCompaction?: (
    messages: Message[],
    journal: FileEntry[],
  ) => void | Promise<void>;
}

export async function createHostedPiSession(
  options: HostedPiSessionOptions,
): Promise<CreateAgentSessionResult> {
  const names = options.tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length)
    throw new Error("Hosted Pi tool names must be unique");
  const settingsManager = SettingsManager.inMemory({
    enableAnalytics: false,
    enableInstallTelemetry: false,
    packages: [],
    extensions: [],
    ...(options.compactionEnabled === undefined
      ? {}
      : { compaction: { enabled: options.compactionEnabled } }),
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    systemPrompt: options.systemPrompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories:
      options.hasPendingConfirmations || options.onCompaction
        ? [
            (pi) => {
              pi.on("turn_end", (_event, context) => {
                if (options.hasPendingConfirmations?.()) context.abort();
              });
              pi.on("session_compact", async () => {
                await options.onCompaction?.(
                  convertToLlm(
                    options.sessionManager.buildSessionContext().messages,
                  ),
                  [
                    options.sessionManager.getHeader()!,
                    ...options.sessionManager.getEntries(),
                  ],
                );
              });
            },
          ]
        : [],
  });
  await resourceLoader.reload();
  return createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    model: options.model,
    modelRuntime: options.modelRuntime,
    sessionManager: options.sessionManager,
    thinkingLevel: options.thinkingLevel,
    settingsManager,
    resourceLoader,
    tools: names,
    customTools: options.tools,
  });
}
