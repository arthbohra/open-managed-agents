import { pathToFileURL } from "node:url";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";

const modulePath = process.argv[2];
if (!modulePath) throw new Error("Pass the pi-loop.ts path to benchmark");
const { PiHarness } = await import(pathToFileURL(modulePath).href);

function makeContext(): HarnessContext {
  const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  faux.setResponses([fauxAssistantMessage("Done")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const events: SessionEvent[] = [];
  for (let index = 0; index < 100; index++) {
    events.push({
      type: "user.message",
      content: [{ type: "text", text: `Question ${index}` }],
    });
    events.push({
      type: "agent.message",
      message_id: `answer-${index}`,
      content: [{ type: "text", text: `Answer ${index}` }],
    });
  }
  events.push({
    type: "user.message",
    content: [{ type: "text", text: "Final question" }],
  });
  const runtime = {
    history: {
      getEvents: () => events,
      getMessages: () => [],
      append: (event: SessionEvent) => events.push(event),
    },
    broadcast: (event: SessionEvent) => events.push(event),
    drain: async () => {},
    broadcastStreamStart: async () => {},
    broadcastChunk: async () => {},
    broadcastStreamEnd: async () => {},
    broadcastThinkingStart: async () => {},
    broadcastThinkingChunk: async () => {},
    broadcastThinkingEnd: async () => {},
    broadcastToolInputStart: async () => {},
    broadcastToolInputChunk: async () => {},
    broadcastToolInputEnd: async () => {},
    pendingConfirmations: [],
    sandbox: {},
  } as unknown as HarnessRuntime;
  return {
    agent: { id: "benchmark", model: faux.getModel().id },
    userMessage: events.at(-1),
    session_id: "benchmark",
    tools: {},
    model: {},
    pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
    systemPrompt: "Answer briefly.",
    env: {},
    runtime,
  } as unknown as HarnessContext;
}

const timings: number[] = [];
for (let index = 0; index < 15; index++) {
  const context = makeContext();
  const started = performance.now();
  await new PiHarness().run(context);
  if (index >= 3) timings.push(performance.now() - started);
}
timings.sort((left, right) => left - right);
console.log(JSON.stringify({
  modulePath,
  events: 201,
  samples: timings.length,
  medianMs: timings[Math.floor(timings.length / 2)],
  p90Ms: timings[Math.floor(timings.length * 0.9)],
}));
