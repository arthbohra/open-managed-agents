import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  isContextOverflow,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { classifyExternalError, ModelError } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessInterface } from "./interface";
import {
  toolsToPi,
  modelMessagesToPi,
  translatePiEvent,
  closeLiveStreams,
} from "./pi-loop";
import { eventsToMessagesAsync } from "../runtime/history";
import { withPiRuntimeRequestOptions } from "./pi-provider";
import {
  closeInterruptedToolCalls,
  createReplayedHostedPiSession,
} from "./pi-session";
import { encodePiContext } from "./pi-context";
import {
  resolvePiCompactionPolicy,
  type PiCompactionPolicy,
  type PiCompactionResult,
} from "./pi-compaction";

export interface PiHarnessOptions {
  compaction?: PiCompactionPolicy;
}

/** Runs Pi with authorized remote tools and OpenMA's durable event history. */
export class PiHarness implements HarnessInterface {
  constructor(private readonly options: PiHarnessOptions = {}) {}

  async run(ctx: HarnessContext): Promise<void> {
    if (!ctx.pi)
      throw new ModelError(
        "Pi harness requires a tenant-scoped Pi model runtime",
      );
    const proactivelyCompacted = await this.compactBeforeTurn(ctx);
    let outcome = await this.runSessionOnce(ctx);
    if (
      outcome.failure &&
      !outcome.producedOutput &&
      !proactivelyCompacted &&
      !ctx.runtime.abortSignal?.aborted &&
      isContextOverflow(outcome.failure, ctx.pi.model.contextWindow) &&
      (await this.compactBeforeTurn(ctx, true))
    )
      outcome = await this.runSessionOnce(ctx);
    if (outcome.failure && !ctx.runtime.abortSignal?.aborted) {
      const message =
        outcome.failure.errorMessage ?? "Pi provider request failed";
      const external = classifyExternalError(new Error(message));
      throw external instanceof Error ? external : new ModelError(message);
    }
    if (!outcome.producedOutput && !ctx.runtime.abortSignal?.aborted)
      throw new ModelError(
        "No output generated. Check the Pi stream for errors.",
      );
  }

  private async compactBeforeTurn(
    ctx: HarnessContext,
    force = false,
  ): Promise<boolean> {
    const runtime = ctx.pi!;
    const policy =
      this.options.compaction ??
      resolvePiCompactionPolicy(
        (ctx.agent.metadata ?? {}) as Record<string, unknown>,
      );
    const events = ctx.runtime.history.getEvents();
    const messages = modelMessagesToPi(
      await eventsToMessagesAsync(events, ctx.fileFetcher),
      runtime.model,
    );
    const contextWindowTokens = runtime.model.contextWindow || 128_000;
    if (
      !force &&
      !policy.shouldCompact(events, { messages, contextWindowTokens })
    )
      return false;
    try {
      const result = await policy.compact(events, {
        messages,
        contextWindowTokens,
        models: runtime.models,
        model: runtime.model,
        systemPrompt: ctx.systemPrompt,
        tools: toolsToPi(ctx),
        runtime: ctx.runtime,
        sessionId: ctx.session_id,
        abortSignal: ctx.runtime.abortSignal,
        requestOptions: withPiRuntimeRequestOptions(runtime, {
          ...(runtime.thinkingLevel === "off"
            ? {}
            : { reasoning: runtime.thinkingLevel }),
        }),
      });
      return this.persistCompaction(result, ctx);
    } catch (error) {
      console.warn(
        `[pi-compact] ${policy.name} failed: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private persistCompaction(
    result: PiCompactionResult | null,
    ctx: HarnessContext,
  ): boolean {
    if (
      !result ||
      !result.summary.some(
        (block) =>
          (block.type === "text" && block.text.trim().length > 0) ||
          block.type === "image" ||
          block.type === "document",
      )
    )
      return false;
    ctx.runtime.broadcast({
      type: "agent.thread_context_compacted",
      original_message_count: result.original_message_count,
      compacted_message_count: result.compacted_message_count,
      summary: result.summary,
      trigger: "auto",
      pre_tokens: result.pre_tokens,
    });
    return true;
  }

  private async runSessionOnce(ctx: HarnessContext): Promise<{
    producedOutput: boolean;
    failure?: AssistantMessage;
  }> {
    const runtime = ctx.pi;
    if (!runtime) throw new Error("Missing tenant Pi runtime");
    const provider = runtime.models.getProvider(runtime.model.provider);
    if (!provider) throw new Error("Missing tenant Pi provider");
    ctx.runtime.abortSignal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), "openma-pi-session-"));
    try {
      const modelRuntime = await ModelRuntime.create({
        authPath: join(directory, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(directory, "models.json"),
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      modelRuntime.registerNativeProvider(provider);
      const events = ctx.runtime.history.getEvents();
      let boundary = -1;
      for (let index = events.length - 1; index >= 0; index--) {
        if (
          events[index]?.type === "agent.thread_context_compacted" &&
          "pi_context" in events[index]
        ) {
          boundary = index;
          break;
        }
      }
      const checkpoint = boundary < 0 ? undefined : events[boundary];
      const saved =
        checkpoint && "pi_context" in checkpoint
          ? String(checkpoint.pi_context)
          : undefined;
      const history = closeInterruptedToolCalls(
        modelMessagesToPi(
          await eventsToMessagesAsync(
            events.slice(boundary + 1),
            ctx.fileFetcher,
          ),
          runtime.model,
        ),
      );
      const last = history.at(-1);
      if (!last || (last.role !== "user" && last.role !== "toolResult"))
        throw new Error(
          "AgentSession continuation requires a user message or durable tool result",
        );
      if (last.role === "user") history.pop();
      let checkpointFailure: unknown;
      const { session } = await createReplayedHostedPiSession({
        cwd: "/workspace",
        agentDir: directory,
        modelRuntime,
        model: runtime.model,
        systemPrompt: ctx.systemPrompt,
        thinkingLevel: runtime.thinkingLevel,
        tools: toolsToPi(ctx),
        history,
        checkpoint: saved,
        hasPendingConfirmations: () =>
          Boolean(ctx.runtime.pendingConfirmations?.length),
        onCompaction: async (messages, journal) => {
          try {
            ctx.runtime.broadcast({
              type: "agent.thread_context_compacted",
              original_message_count: history.length,
              compacted_message_count: messages.length,
              pi_context: encodePiContext(messages, journal),
            });
            await ctx.runtime.drain?.();
          } catch (error: unknown) {
            checkpointFailure = error;
            session.agent.abort();
          }
        },
      });
      const stream = session.agent.streamFunction;
      session.agent.streamFunction = (model, context, options) => {
        if (checkpointFailure) throw checkpointFailure;
        return stream(
          model,
          context,
          withPiRuntimeRequestOptions(runtime, options),
        );
      };
      const state = {
        spanId: null,
        firstTokenSeen: false,
        textIds: new Map<number, string>(),
        thinkingIds: new Map<number, string>(),
        toolIds: new Map<number, string>(),
      };
      let writes = Promise.resolve();
      let failure: AssistantMessage | undefined;
      let producedOutput = false;
      let writeFailure: unknown;
      const unsubscribe = session.agent.subscribe((event) => {
        writes = writes
          .then(async () => {
            const outcome = await translatePiEvent(event, ctx, state);
            producedOutput ||= outcome.producedOutput;
            if (
              event.type === "message_end" &&
              event.message.role === "assistant"
            )
              failure = outcome.providerFailure;
          })
          .catch((error: unknown) => {
            writeFailure ??= error;
            session.agent.abort();
          });
        return writes;
      });
      const abort = () => session.agent.abort();
      ctx.runtime.abortSignal?.addEventListener("abort", abort, { once: true });
      try {
        ctx.runtime.abortSignal?.throwIfAborted();
        const send = async () => {
          if (last.role === "toolResult") {
            await session.sendCustomMessage(
              {
                customType: "openma_tool_result_continuation",
                content:
                  "Continue from the recorded tool results. Do not repeat completed operations.",
                display: false,
              },
              { triggerTurn: true },
            );
          } else {
            const content =
              typeof last.content === "string"
                ? [{ type: "text" as const, text: last.content }]
                : last.content;
            await session.prompt(
              content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
              {
                images: content.filter((part) => part.type === "image"),
                expandPromptTemplates: false,
              },
            );
          }
        };
        if (ctx.runtime.keepAliveWhile) await ctx.runtime.keepAliveWhile(send);
        else await send();
        await writes;
        if (checkpointFailure) throw checkpointFailure;
        if (writeFailure) throw writeFailure;
      } finally {
        unsubscribe();
        ctx.runtime.abortSignal?.removeEventListener("abort", abort);
        session.dispose();
        await writes;
        await closeLiveStreams(
          ctx,
          state,
          ctx.runtime.abortSignal?.aborted ? "aborted" : "completed",
        );
      }
      await ctx.runtime.drain?.();
      return { producedOutput, ...(failure ? { failure } : {}) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
