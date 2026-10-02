import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import {
  FileService,
  SqlFileRepo,
  encodeOutputId,
} from "@open-managed-agents/files-store";
import { sessionOutputsPrefix } from "@open-managed-agents/shared";
import { createR2SessionOutputSource } from "../../apps/main/src/lib/r2-session-output-source";
import type { UnifiedPageHarness } from "../../packages/files-store/src/unified-page.harness";
import { registerUnifiedFilePageScenarios } from "../../packages/files-store/src/unified-page.scenarios";

const H = { "x-api-key": "test-key" };

function db(): D1Database {
  return (env as { MAIN_DB: D1Database }).MAIN_DB;
}

function bucket(): R2Bucket {
  return (env as { FILES_BUCKET: R2Bucket }).FILES_BUCKET;
}

beforeAll(async () => {
  await exports.default.fetch(new Request("http://localhost/health", { headers: H }));
});

describe("unified session file page (Cloudflare D1 + R2)", () => {
  registerUnifiedFilePageScenarios(() => Promise.resolve(createCfHarness()), {
    bulkOutputCount: 1001,
  });

  it("GET /v1/oma/files pages across D1 and R2 without repeating a page", async () => {
    const sessionId = `sess_http_${crypto.randomUUID().slice(0, 8)}`;
    const newerId = `file-newer-${sessionId}`;
    const olderId = `file-older-${sessionId}`;
    const repo = new SqlFileRepo(drizzle(db()));
    const prefix = sessionOutputsPrefix("default", sessionId);
    await db().prepare(`DELETE FROM files WHERE id = ?`).bind(newerId).run();
    await db().prepare(`DELETE FROM files WHERE id = ?`).bind(olderId).run();
    await repo.insert(row("default", sessionId, newerId, 3_000));
    await repo.insert(row("default", sessionId, olderId, 2_000));
    await bucket().put(`${prefix}a.txt`, "a");
    await bucket().put(`${prefix}b.txt`, "b");
    await bucket().put(`${prefix}c.txt`, "c");

    const expected = [
      newerId,
      olderId,
      encodeOutputId(sessionId, "a.txt"),
      encodeOutputId(sessionId, "b.txt"),
      encodeOutputId(sessionId, "c.txt"),
    ];
    const seen: string[] = [];
    let cursor: string | undefined;
    let previous = "";
    for (let i = 0; i < expected.length + 1; i++) {
      const url = new URL("http://localhost/v1/oma/files");
      url.searchParams.set("scope_id", sessionId);
      url.searchParams.set("limit", "1");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await exports.default.fetch(new Request(url, { headers: H }));
      expect(res.status).toBe(200);
      const body = await res.json() as {
        data: Array<{ id: string }>;
        has_more: boolean;
        next_cursor?: string;
        last_id?: string;
      };
      expect(body.data.length).toBeLessThanOrEqual(1);
      if (body.data.length === 0) {
        expect(body.has_more).toBe(false);
        break;
      }
      expect(body.data).toHaveLength(1);
      const signature = body.data[0]!.id;
      expect(signature).not.toBe(previous);
      previous = signature;
      seen.push(signature);
      if (!body.has_more) break;
      expect(body.next_cursor).toEqual(expect.any(String));
      const byId = await exports.default.fetch(new Request(
        `http://localhost/v1/oma/files?scope_id=${sessionId}&limit=1&before_id=${encodeURIComponent(body.last_id ?? "")}`,
        { headers: H },
      ));
      const byIdBody = await byId.json() as { data: Array<{ id: string }> };
      const byCursor = await exports.default.fetch(new Request(
        `http://localhost/v1/oma/files?scope_id=${sessionId}&limit=1&cursor=${encodeURIComponent(body.next_cursor ?? "")}`,
        { headers: H },
      ));
      const byCursorBody = await byCursor.json() as { data: Array<{ id: string }> };
      expect(byIdBody.data.map((item) => item.id)).toEqual(byCursorBody.data.map((item) => item.id));
      cursor = body.next_cursor;
    }
    expect(seen).toEqual(expected);
  });
});

function createCfHarness(): UnifiedPageHarness {
  const tenantId = `tenant_${crypto.randomUUID()}`;
  const sessionId = `sess_${crypto.randomUUID()}`;
  const otherTenantId = `tenant_${crypto.randomUUID()}`;
  const otherSessionId = `sess_${crypto.randomUUID()}`;
  const repo = new SqlFileRepo(drizzle(db()));
  const service = new FileService({ repo });
  const outputs = createR2SessionOutputSource(bucket());
  return {
    tenantId,
    sessionId,
    otherTenantId,
    otherSessionId,
    async insertFile(input) {
      const owner = input.tenantId ?? tenantId;
      const session = input.sessionId ?? sessionId;
      await db().prepare(`DELETE FROM files WHERE id = ?`).bind(input.id).run();
      await repo.insert(row(owner, session, input.id, input.createdAtMs, input.filename));
    },
    async insertOutput(input) {
      const owner = input.tenantId ?? tenantId;
      const session = input.sessionId ?? sessionId;
      await bucket().put(
        `${sessionOutputsPrefix(owner, session)}${input.filename}`,
        input.bytes ?? "x",
      );
    },
    async deleteFile(id) {
      await repo.delete(tenantId, id);
    },
    async deleteOutput(filename, session) {
      await bucket().delete(`${sessionOutputsPrefix(tenantId, session ?? sessionId)}${filename}`);
    },
    list(input) {
      return service.listUnifiedPage({
        tenantId: input.tenantId ?? tenantId,
        scopeId: input.scopeId ?? sessionId,
        outputs,
        limit: input.limit,
        order: input.order,
        cursor: input.cursor,
        beforeId: input.beforeId,
        afterId: input.afterId,
      });
    },
  };
}

function row(
  tenantId: string,
  sessionId: string,
  id: string,
  createdAtMs: number,
  filename?: string,
) {
  return {
    id,
    tenantId,
    sessionId,
    scope: "session" as const,
    filename: filename ?? `${id}.txt`,
    mediaType: "text/plain",
    sizeBytes: 1,
    downloadable: true,
    r2Key: `t/${tenantId}/files/${id}`,
    createdAt: createdAtMs,
  };
}
