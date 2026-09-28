# Managed Session persistence: documented semantics vs OpenMA implementation

This note is about the **official `/v1/sessions` Managed Agents path**. The legacy `/v1/oma/sessions` and `S3MemoryPoller` are separate code paths; do not use their behavior to certify this path.

## Anthropic's published contract

- [Using agent memory — How the agent accesses memory](https://platform.claude.com/docs/en/managed-agents/memory#how-the-agent-accesses-memory): a memory store is presented under `/mnt/memory/<name>/`; writes to a read-write store persist and are shared across sessions. For **self-hosted** sandboxes it is a *local copy*, not a live remote mount. The SDK worker reconciles after tool calls, at most once per sync interval (15 seconds by default), and on session end. A change becomes visible to another running self-hosted session after **both workers** sync.
- [Self-hosted sandboxes — How the worker handles memory](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes#how-the-worker-handles-memory): `EnvironmentWorker` downloads attached stores, synchronizes local and remote edits, uploads pending changes on graceful cancellation/session end, and cleans up local directories. Hard-killed workers can lose unsynced local edits. [Configure sync](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes#configure-sync) documents the interval and deletion policy (enabled by default).
- [Attach and download files](https://platform.claude.com/docs/en/managed-agents/files): on **Anthropic-hosted** sandboxes, files under `/mnt/session/outputs/` appear in the Files API shortly after writing, possibly a few seconds **after** `session.status_idle`. Idle alone is not proof that upload completed. [Self-hosted sandbox filesystem](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes#sandbox-filesystem) instead places deliverables in the user's sandbox filesystem, typically `/workspace`; it does **not** promise automatic `/mnt/session/outputs` uploads there.
- Provider reference implementations differ. See [Claude Managed Agents sandbox provider adapter audit](claude-managed-agents-sandbox-provider-audit.md): the official SDK worker can be run inside a per-session sandbox, whereas provider-specific E2B/Cloudflare/etc. examples also include control-plane routing. They target Anthropic Environment Work; they are not automatically plug-compatible with OpenMA's embedded adapter.

## What the current OpenMA code actually does

- `apps/main-node/src/lib/node-managed-session-inputs.ts` materializes memory snapshots and invokes `mountMemoryStore`, and invokes `mountSessionOutputs` for every managed session.
- `apps/main-node/src/lib/node-managed-session-runner.ts` calls `synchronizeSandbox` at **turn finalization before** emitting `session.status_idle`; it does not perform the Anthropic SDK worker's after-tool-call 15-second reconciliation. The synchronization hook in `apps/main-node/src/modules/node-managed.ts` reconciles writable memory workspaces through a fenced canonical API, then collects outputs.
- `apps/main-node/src/lib/node-managed-session-outputs.ts` has a `best_effort` collector but currently stages outputs in a node-local `outputsRoot`; it is not a cross-replica durable sink. The existing E2B adapter instead advertises a `durable` mount if bucket configuration is present. Changing its capability label is not a persistence implementation.
- `apps/main-node/src/lib/s3-memory-poller.ts` indexes the **legacy** memory repository and is not the official Managed Session workspace synchronizer.

## Acceptance needed before a multi-replica claim

Prove with two independent control-plane processes and a shared SQL/object store: A writes memory and outputs, B reads them after the documented synchronization boundary; a stopped A cannot erase B's result; stale execution attempts fail the fence; deletion/conflicts are reconciled. For self-hosted-like semantics, separately test visibility **during a long turn** after the configured sync interval, and graceful cancellation/unsynced hard kill. For outputs, test readback after the writer process is gone, not merely existence under its local filesystem. Provider adapter tests do not replace these core tests.

These are the external semantics and current implementation observations, **not a claim that OpenMA has already passed the acceptance tests**.
