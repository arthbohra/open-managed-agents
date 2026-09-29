import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryBlobStore } from "@open-managed-agents/blob-store";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { ensureSessionExecutionCoordinatorSchema, SqlSessionExecutionCoordinator } from "@open-managed-agents/session-runtime-sql";
import type { SessionExecutionFence } from "@open-managed-agents/session-runtime-contract/coordination";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import { NodeManagedWorkspaceCheckpoints } from "../src/lib/node-managed-workspace-checkpoints.js";
import { DefaultNodeManagedSessionRunner } from "../src/lib/node-managed-session-runner.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function sandbox(): Promise<SandboxExecutor> {
  const root = await mkdtemp(join(tmpdir(), "oma-checkpoint-sandbox-"));
  roots.push(root);
  await mkdir(join(root, "workspace"));
  await mkdir(join(root, "tmp"));
  const path = (name: string) => name.replace(/^\/workspace\b/, join(root, "workspace"))
    .replace(/^\/tmp\b/, join(root, "tmp"));
  return {
    async exec(command) {
      const cmd = command.replace(/\/workspace\b/g, join(root, "workspace"))
        .replace(/\/tmp\b/g, join(root, "tmp"));
      const result = spawnSync("/bin/sh", ["-c", cmd], { encoding: "utf8" });
      return result.status === 0 ? result.stdout : `${result.stderr}[exit ${result.status}]`;
    },
    readFile: (name) => readFile(path(name), "utf8"),
    readFileBytes: async (name) => new Uint8Array(await readFile(path(name))),
    writeFile: async (name, content) => { await writeFile(path(name), content); return name; },
    writeFileBytes: async (name, content) => { await writeFile(path(name), content); return name; },
    destroy: async () => rm(root, { force: true, recursive: true }),
  } as SandboxExecutor;
}

const scope = { workspaceId: "workspace_1", environmentId: "env_1", sessionId: "session_1", workId: "exec_1" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "oma-checkpoint-sql-"));
  roots.push(root);
  const sql = await createBetterSqlite3SqlClient(join(root, "checkpoint.db"));
  await ensureSessionExecutionCoordinatorSchema(sql);
  const coordinator = new SqlSessionExecutionCoordinator(sql);
  const now = Date.now();
  await coordinator.admit({ execution: {
    id: "exec_1", workspaceId: scope.workspaceId, sessionId: scope.sessionId,
    admittedAt: new Date(now - 100).toISOString(),
    events: [{ id: "event_1", type: "user.message", content: [{ type: "text", text: "hello" }] }] as never,
  } });
  const claim = await coordinator.claim({
    workspaceId: scope.workspaceId, sessionId: scope.sessionId,
    ownerId: "replica_a", attemptId: "attempt_1", claimedAt: new Date(now).toISOString(), leaseTtlMs: 120_000,
  });
  if (claim.type !== "claimed") throw new Error("Expected claimed execution");
  const blobs = new InMemoryBlobStore();
  const checkpoints = new NodeManagedWorkspaceCheckpoints({ sql, blobs, intervalMs: 30_000 });
  await checkpoints.ensureSchema();
  return { checkpoints, blobs, sql, coordinator, fence: claim.fence };
}

async function createCandidate(
  checkpoints: NodeManagedWorkspaceCheckpoints,
  executor: SandboxExecutor,
  fence: SessionExecutionFence,
) {
  const port = checkpoints.port(executor);
  const runtimeFence = checkpoints.runtimeFence(fence, scope.environmentId);
  const binding = await port.materialize({
    scope, fence: runtimeFence, strategy: "checkpoint_restore", activeCheckpoint: null,
    idempotencyKey: "prepare", signal: new AbortController().signal,
  });
  return port.checkpoint({
    scope, fence: runtimeFence, strategy: "checkpoint_restore", binding,
    sandbox: { provider: "node", runtimeId: "sandbox_1" },
    idempotencyKey: "candidate_1", signal: new AbortController().signal,
  });
}

describe("official Node Managed Session workspace checkpoints", () => {
  it("publishes a portable immutable checkpoint and restores it in a fresh sandbox / process", async () => {
    const { checkpoints, blobs, sql, fence } = await fixture();
    const oldSandbox = await sandbox();
    await oldSandbox.writeFile("/workspace/report.txt", "before crash");
    const candidate = await createCandidate(checkpoints, oldSandbox, fence);
    expect(candidate.contentHash).toMatch(/^sha256:/);
    expect(await checkpoints.publish({ fence, candidate, expectedId: null })).toBe(true);
    await oldSandbox.destroy?.();

    const otherProcess = new NodeManagedWorkspaceCheckpoints({ sql, blobs, intervalMs: 30_000 });
    const active = await otherProcess.active(scope);
    expect(active?.candidate.id).toBe(candidate.id);
    const freshSandbox = await sandbox();
    const port = otherProcess.port(freshSandbox);
    const runtimeFence = otherProcess.runtimeFence(fence, scope.environmentId);
    const binding = await port.materialize({
      scope, fence: runtimeFence, strategy: "checkpoint_restore", activeCheckpoint: active!.candidate,
      idempotencyKey: "cold-restore", signal: new AbortController().signal,
    });
    await port.attach({ scope, fence: runtimeFence, strategy: "checkpoint_restore", binding,
      sandbox: { provider: "node", runtimeId: "sandbox_2" }, signal: new AbortController().signal });
    await expect(freshSandbox.readFile("/workspace/report.txt")).resolves.toBe("before crash");
  });

  it("fails closed when canonical bytes disappear or are corrupt", async () => {
    const { checkpoints, blobs, fence } = await fixture();
    const first = await sandbox();
    await first.writeFile("/workspace/report.txt", "original");
    const candidate = await createCandidate(checkpoints, first, fence);
    await checkpoints.publish({ fence, candidate, expectedId: null });
    const key = candidate.metadata?.["openma.workspace.blob-key.v1"];
    expect(typeof key).toBe("string");
    await blobs.delete(key as string);
    const fresh = await sandbox();
    const port = checkpoints.port(fresh);
    const runtimeFence = checkpoints.runtimeFence(fence, scope.environmentId);
    const binding = await port.materialize({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      activeCheckpoint: candidate, idempotencyKey: "restore", signal: new AbortController().signal });
    await expect(port.attach({ scope, fence: runtimeFence, strategy: "checkpoint_restore", binding,
      sandbox: { provider: "node", runtimeId: "sandbox_2" }, signal: new AbortController().signal }))
      .rejects.toThrow(/missing|restore/i);
    expect(await checkpoints.active(scope)).toMatchObject({ candidate: { id: candidate.id } });
  });

  it("rejects a stale fence and a stale active pointer without advancing the canonical checkpoint", async () => {
    const { checkpoints, sql, fence } = await fixture();
    const first = await sandbox();
    await first.writeFile("/workspace/report.txt", "first");
    const a = await createCandidate(checkpoints, first, fence);
    expect(await checkpoints.publish({ fence, candidate: a, expectedId: null })).toBe(true);
    await first.writeFile("/workspace/report.txt", "second");
    const b = await createCandidate(checkpoints, first, fence);
    expect(await checkpoints.publish({ fence, candidate: b, expectedId: null })).toBe(false);
    expect((await checkpoints.active(scope))?.candidate.id).toBe(a.id);
    await sql.prepare("UPDATE managed_session_executions SET attempt_id = 'attempt_2', generation = generation + 1 WHERE workspace_id = ? AND id = ?")
      .bind(scope.workspaceId, scope.workId).run();
    expect(await checkpoints.publish({ fence, candidate: b, expectedId: a.id })).toBe(false);
    expect((await checkpoints.active(scope))?.candidate.id).toBe(a.id);
  });

  it("restores before Session input staging and publishes at a fenced safe turn barrier", async () => {
    const { checkpoints, blobs, sql, fence } = await fixture();
    const oldSandbox = await sandbox();
    await oldSandbox.writeFile("/workspace/report.txt", "canonical");
    const previous = await createCandidate(checkpoints, oldSandbox, fence);
    await checkpoints.publish({ fence, candidate: previous, expectedId: null });
    await oldSandbox.destroy?.();
    const fresh = await sandbox();
    const order: string[] = [];
    const checkpointService = new NodeManagedWorkspaceCheckpoints({ sql, blobs, intervalMs: 1, nowMs: () => Date.now() + 2_000 });
    const session = { id: scope.sessionId, agent: { skills: [] }, resources: [] } as never;
    const environment = { id: scope.environmentId, config: {} } as never;
    const runner = new DefaultNodeManagedSessionRunner({
      workspaceCheckpoints: checkpointService,
      buildSandbox: async () => fresh,
      prepareSandbox: async () => {
        order.push("prepare");
        expect(await fresh.readFile("/workspace/report.txt")).toBe("canonical");
      },
      synchronizeSandbox: async () => { order.push("memory-outputs"); },
      outcomes: { evaluate: async () => { throw new Error("unexpected"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected"); } },
      buildModel: async () => ({} as never), buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {
        order.push("run");
        await fresh.writeFile("/workspace/report.txt", "next version");
      } }),
      buildHarnessContext: async (input) => input as never,
      clock: { now: () => new Date() }, ids: { nextEventId: () => `evt_${Math.random()}` },
    });
    await runner.start({ workspaceId: scope.workspaceId, sessionId: scope.sessionId,
      session, environment, initialEvents: [], executionFence: fence });
    const event = { id: "event_1", type: "user.message", content: [{ type: "text", text: "run" }], processedAt: new Date().toISOString() } as never;
    await runner.accept({ workspaceId: scope.workspaceId, sessionId: scope.sessionId,
      session, environment, initialEvents: [], events: [event], historyEvents: [event],
      executionFence: fence, output: async () => undefined });
    expect(order).toEqual(["prepare", "run", "memory-outputs"]);
    const active = await checkpoints.active(scope);
    expect(active?.candidate.id).not.toBe(previous.id);
    const third = await sandbox();
    const port = checkpoints.port(third);
    const runtimeFence = checkpoints.runtimeFence(fence, scope.environmentId);
    const binding = await port.materialize({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      activeCheckpoint: active!.candidate, idempotencyKey: "restore", signal: new AbortController().signal });
    await port.attach({ scope, fence: runtimeFence, strategy: "checkpoint_restore", binding,
      sandbox: { provider: "node", runtimeId: "sandbox_3" }, signal: new AbortController().signal });
    expect(await third.readFile("/workspace/report.txt")).toBe("next version");
  });

  it("never stages inputs or exposes a new sandbox when the canonical restore fails", async () => {
    const { checkpoints, blobs, fence } = await fixture();
    const old = await sandbox();
    await old.writeFile("/workspace/report.txt", "canonical");
    const candidate = await createCandidate(checkpoints, old, fence);
    await checkpoints.publish({ fence, candidate, expectedId: null });
    await blobs.delete(candidate.metadata!["openma.workspace.blob-key.v1"] as string);
    const fresh = await sandbox();
    let destroyed = false;
    const originalDestroy = fresh.destroy?.bind(fresh);
    fresh.destroy = async () => { destroyed = true; await originalDestroy?.(); };
    let inputsPrepared = false;
    const runner = new DefaultNodeManagedSessionRunner({
      workspaceCheckpoints: checkpoints,
      buildSandbox: async () => fresh,
      prepareSandbox: async () => { inputsPrepared = true; },
      outcomes: { evaluate: async () => { throw new Error("unexpected"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected"); } },
      buildModel: async () => ({} as never), buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => undefined }),
      buildHarnessContext: async (input) => input as never,
      clock: { now: () => new Date() }, ids: { nextEventId: () => "evt_1" },
    });
    await expect(runner.start({ workspaceId: scope.workspaceId, sessionId: scope.sessionId,
      session: { id: scope.sessionId, resources: [], agent: { skills: [] } } as never,
      environment: { id: scope.environmentId, config: {} } as never,
      initialEvents: [], executionFence: fence })).rejects.toThrow(/missing/i);
    expect(inputsPrepared).toBe(false);
    expect(destroyed).toBe(true);
    expect(runner.connectedSandbox(scope)).toBeNull();
  });

  it("discards uncommitted workspace writes after a failed attempt instead of reusing that sandbox", async () => {
    const { checkpoints, fence } = await fixture();
    const first = await sandbox();
    const second = await sandbox();
    let allocations = 0;
    let destroyed = false;
    const firstDestroy = first.destroy?.bind(first);
    first.destroy = async () => { destroyed = true; await firstDestroy?.(); };
    const session = { id: scope.sessionId, resources: [], agent: { skills: [] } } as never;
    const environment = { id: scope.environmentId, config: {} } as never;
    const runner = new DefaultNodeManagedSessionRunner({
      workspaceCheckpoints: checkpoints,
      buildSandbox: async () => ++allocations === 1 ? first : second,
      outcomes: { evaluate: async () => { throw new Error("unexpected"); } },
      confirmedTools: { execute: async () => { throw new Error("unexpected"); } },
      buildModel: async () => ({} as never), buildTools: async () => ({}),
      buildHarness: () => ({ run: async () => {
        await first.writeFile("/workspace/uncommitted.txt", "never published");
        throw new Error("harness failed");
      } }),
      buildHarnessContext: async (input) => input as never,
      clock: { now: () => new Date() }, ids: { nextEventId: () => "evt_1" },
    });
    const start = { workspaceId: scope.workspaceId, sessionId: scope.sessionId,
      session, environment, initialEvents: [], executionFence: fence };
    await runner.start(start);
    const event = { id: "event_1", type: "user.message", content: [{ type: "text", text: "run" }] } as never;
    await expect(runner.accept({ ...start, events: [event], historyEvents: [event],
      output: async () => undefined })).rejects.toThrow("harness failed");
    const reclaimed = { ...fence, attemptId: "attempt_2", generation: fence.generation + 1 };
    await runner.start({ ...start, executionFence: reclaimed });
    expect(allocations).toBe(2);
    expect(destroyed).toBe(true);
    expect(runner.connectedSandbox(scope)).toBe(second);
    await expect(second.readFile("/workspace/uncommitted.txt")).rejects.toThrow(/ENOENT/);
  });

  it("fails closed on the real local-subprocess exit suffix during archive and restore", async () => {
    const { checkpoints, fence } = await fixture();
    const source = await sandbox();
    await source.writeFile("/workspace/report.txt", "canonical");
    const good = await createCandidate(checkpoints, source, fence);
    expect(await checkpoints.publish({ fence, candidate: good, expectedId: null })).toBe(true);
    const runtimeFence = checkpoints.runtimeFence(fence, scope.environmentId);
    const brokenArchive = checkpoints.port({ ...source, exec: async () => "[exit exit=2]" });
    const newBinding = await brokenArchive.materialize({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      activeCheckpoint: null, idempotencyKey: "archive-fail", signal: new AbortController().signal });
    await expect(brokenArchive.checkpoint({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      binding: newBinding, sandbox: { provider: "node", runtimeId: "sandbox_1" },
      idempotencyKey: "archive-fail", signal: new AbortController().signal })).rejects.toThrow(/archive failed/i);
    const fresh = await sandbox();
    const brokenRestore = checkpoints.port({ ...fresh,
      exec: async (command, timeout) => command.includes("tar -xf") ? "[exit exit=2]" : fresh.exec(command, timeout),
    });
    const oldBinding = await brokenRestore.materialize({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      activeCheckpoint: good, idempotencyKey: "restore-fail", signal: new AbortController().signal });
    await expect(brokenRestore.attach({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      binding: oldBinding, sandbox: { provider: "node", runtimeId: "sandbox_2" },
      signal: new AbortController().signal })).rejects.toThrow(/restore failed/i);
  });

  it("rejects oversized archives before loading sandbox or S3 bytes", async () => {
    const { checkpoints, fence, blobs, sql } = await fixture();
    const first = await sandbox();
    await first.writeFile("/workspace/report.txt", "canonical");
    const candidate = await createCandidate(checkpoints, first, fence);
    expect(await checkpoints.publish({ fence, candidate, expectedId: null })).toBe(true);
    const runtimeFence = checkpoints.runtimeFence(fence, scope.environmentId);
    let sandboxRead = false;
    const huge = checkpoints.port({ ...first,
      exec: async (command, timeout) => command.startsWith("wc -c")
        ? String(256 * 1024 * 1024 + 1)
        : first.exec(command, timeout),
      readFileBytes: async () => { sandboxRead = true; throw new Error("should not read huge tar"); },
    });
    const newBinding = await huge.materialize({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      activeCheckpoint: null, idempotencyKey: "size", signal: new AbortController().signal });
    await expect(huge.checkpoint({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      binding: newBinding, sandbox: { provider: "node", runtimeId: "sandbox_1" },
      idempotencyKey: "size", signal: new AbortController().signal })).rejects.toThrow(/maximum size/);
    expect(sandboxRead).toBe(false);
    let remoteRead = false;
    const oversized = new NodeManagedWorkspaceCheckpoints({ sql, intervalMs: 30_000,
      blobs: {
        head: async () => ({ size: 256 * 1024 * 1024 + 1, etag: "too-big" }),
        get: async () => { remoteRead = true; throw new Error("should not GET huge blob"); },
        put: (...args) => blobs.put(...args), delete: (key) => blobs.delete(key),
      },
    });
    const port = oversized.port(await sandbox());
    const binding = await port.materialize({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      activeCheckpoint: candidate, idempotencyKey: "restore-huge", signal: new AbortController().signal });
    await expect(port.attach({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      binding, sandbox: { provider: "node", runtimeId: "sandbox_2" }, signal: new AbortController().signal }))
      .rejects.toThrow(/maximum size/);
    expect(remoteRead).toBe(false);
    const streaming = new NodeManagedWorkspaceCheckpoints({ sql, intervalMs: 30_000,
      blobs: {
        head: (key) => blobs.head(key),
        get: async (key) => {
          const blob = await blobs.get(key);
          return blob === null ? null : {
            ...blob,
            bytes: async () => { throw new Error("unbounded archive read"); },
          };
        },
        put: (...args) => blobs.put(...args), delete: (key) => blobs.delete(key),
      },
    });
    const restored = await sandbox();
    const streamPort = streaming.port(restored);
    const streamBinding = await streamPort.materialize({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      activeCheckpoint: candidate, idempotencyKey: "restore-stream", signal: new AbortController().signal });
    await expect(streamPort.attach({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      binding: streamBinding, sandbox: { provider: "node", runtimeId: "sandbox_3" },
      signal: new AbortController().signal })).resolves.toBeUndefined();
    expect(await restored.readFile("/workspace/report.txt")).toBe("canonical");
  });

  it("does not publish when uploading a candidate fails and never snapshots a durable mount", async () => {
    const { checkpoints, fence } = await fixture();
    const failing = await sandbox();
    const port = checkpoints.port({ ...failing, readFileBytes: async () => { throw new Error("upload failed"); } });
    const runtimeFence = checkpoints.runtimeFence(fence, scope.environmentId);
    const binding = await port.materialize({ scope, fence: runtimeFence, strategy: "checkpoint_restore",
      activeCheckpoint: null, idempotencyKey: "prepare", signal: new AbortController().signal });
    await expect(port.checkpoint({ scope, fence: runtimeFence, strategy: "checkpoint_restore", binding,
      sandbox: { provider: "node", runtimeId: "sandbox_1" }, idempotencyKey: "fail", signal: new AbortController().signal }))
      .rejects.toThrow("upload failed");
    expect(await checkpoints.active(scope)).toBeNull();
    expect((await port.capabilities(scope)).strategies).toEqual(["checkpoint_restore"]);
    await expect(port.materialize({ scope, fence: runtimeFence, strategy: "durable_mount",
      activeCheckpoint: null, idempotencyKey: "wrong", signal: new AbortController().signal }))
      .rejects.toThrow(/does not support/);
  });
});
