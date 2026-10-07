import type { Message } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type FileEntry,
} from "@earendil-works/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export function encodePiContext(
  messages: readonly Message[],
): string {
  // Persist only the post-compaction model context, not the full append-only
  // journal. The latter grows without bound even after native compaction.
  const context = JSON.stringify({ version: 1, messages });
  // The event log spills events above 500 kB; keep the wrapped checkpoint
  // below that threshold so the compaction boundary is committed in SQLite.
  const eventBytes = new TextEncoder().encode(
    JSON.stringify({ pi_context: context }),
  ).byteLength;
  if (eventBytes > 450_000)
    throw new Error("Pi compaction checkpoint exceeds 450 kB");
  return context;
}

export async function restorePiContext(
  value: string | undefined,
  cwd: string,
  directory: string,
): Promise<SessionManager> {
  if (!value) return SessionManager.inMemory(cwd);
  const parsed = JSON.parse(value);
  if (parsed.version === 1) {
    const manager = SessionManager.inMemory(cwd);
    for (const message of decodePiContext(value))
      manager.appendMessage(message);
    return manager;
  }
  if (
    parsed.version !== 2 ||
    !Array.isArray(parsed.journal) ||
    parsed.journal[0]?.type !== "session" ||
    !parsed.journal.some(
      (entry: { type?: string }) => entry.type === "compaction",
    )
  )
    throw new Error("Invalid Pi journal checkpoint");
  const path = join(directory, "checkpoint.jsonl");
  await writeFile(
    path,
    parsed.journal.map((entry: unknown) => JSON.stringify(entry)).join("\n") +
      "\n",
    { mode: 0o600 },
  );
  return SessionManager.open(path, directory, cwd);
}

export function decodePiContext(value: string): Message[] {
  const checkpoint = JSON.parse(value) as {
    version?: unknown;
    messages?: unknown;
  };
  if (checkpoint?.version !== 1 || !Array.isArray(checkpoint.messages))
    throw new Error("Unsupported Pi context checkpoint");
  for (const message of checkpoint.messages) {
    if (
      !message ||
      typeof message !== "object" ||
      !["user", "assistant", "toolResult"].includes(message.role) ||
      !(typeof message.content === "string" || Array.isArray(message.content))
    )
      throw new Error("Invalid Pi context checkpoint message");
  }
  return checkpoint.messages as Message[];
}
