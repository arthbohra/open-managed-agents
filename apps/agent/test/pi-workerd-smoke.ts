import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

export default {
  async fetch(): Promise<Response> {
    const directory = await mkdtemp(join(tmpdir(), "openma-workerd-pi-"));
    try {
      const modelRuntime = await ModelRuntime.create({
        authPath: join(directory, "auth.json"),
        modelsPath: null,
        modelsStorePath: join(directory, "models.json"),
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
      faux.setResponses([fauxAssistantMessage("WORKER_OK")]);
      modelRuntime.registerNativeProvider(faux.provider);
      const settingsManager = SettingsManager.inMemory({
        packages: [], extensions: [], enableAnalytics: false,
        enableInstallTelemetry: false,
      });
      const loader = new DefaultResourceLoader({
        cwd: "/workspace",
        agentDir: directory,
        settingsManager,
        systemPrompt: "Answer briefly.",
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd: "/workspace",
        agentDir: directory,
        model: faux.getModel(),
        modelRuntime,
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory("/workspace"),
      });
      try {
        await session.prompt("Say WORKER_OK", { expandPromptTemplates: false });
        return Response.json({ messages: session.messages });
      } finally {
        session.dispose();
      }
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
};
