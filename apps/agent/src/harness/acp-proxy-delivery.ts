import { createHash } from "node:crypto";

/** Matches `packages/cli/src/bridge/lib/session-cwd.ts` dirNameFor. */
export function acpSessionScratchDirName(sessionId: string): string {
  if (/^[a-f0-9]{1,12}$/i.test(sessionId)) return sessionId.toLowerCase();
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 12);
}

/** Default daemon bundle root when OMA_PROFILE is unset (see platform.ts). */
export function defaultAcpBundleRoot(sessionId: string): string {
  const dir = acpSessionScratchDirName(sessionId);
  return `~/.oma/bridge/sessions/${dir}`;
}

type ResourceRow = {
  type?: string;
  resource: Record<string, unknown>;
};

function nonEmptyPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Local filesystem directory for the session's repository mount on a user's
 * ACP runtime. Prefers explicit `local_path`; falls back to `mount_path` when
 * it is not a cloud-sandbox virtual path under `/workspace`.
 */
export function resolveRepositoryLocalPath(rows: ResourceRow[]): string | undefined {
  for (const row of rows) {
    if (row.type !== "github_repository" && row.type !== "github_repo") continue;
    const resource = row.resource;
    const local =
      nonEmptyPath(resource.local_path) ??
      nonEmptyPath(resource.localPath);
    if (local) return local;
    const mount =
      nonEmptyPath(resource.mount_path) ??
      nonEmptyPath(resource.mountPath);
    if (mount && !mount.startsWith("/workspace")) return mount;
  }
  return undefined;
}

export function buildAcpPlatformPromptPrefix(input: {
  sessionId: string;
  systemPrompt: string;
  projectCwd: string;
}): string {
  const bundleRoot = defaultAcpBundleRoot(input.sessionId);
  return [
    "<openma-acp-platform>",
    "Your process cwd is the project repository. OpenMA platform context (AGENTS.md and skill files) is materialized outside that directory.",
    `Read \`${bundleRoot}/AGENTS.md\` and any skill files under \`${bundleRoot}/.claude/skills/\`, \`${bundleRoot}/.opencode/agents/\`, or paths referenced inside AGENTS.md before relying on project-local discovery.`,
    "",
    input.systemPrompt,
    "</openma-acp-platform>",
    "",
  ].join("\n");
}

export function augmentAcpUserPrompt(
  userText: string,
  input: { sessionId: string; systemPrompt: string; projectCwd?: string },
): string {
  if (!input.projectCwd) return userText;
  const prefix = buildAcpPlatformPromptPrefix({
    sessionId: input.sessionId,
    systemPrompt: input.systemPrompt,
    projectCwd: input.projectCwd,
  });
  return `${prefix}${userText}`;
}
