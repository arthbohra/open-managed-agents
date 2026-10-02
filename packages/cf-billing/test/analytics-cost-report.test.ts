import { describe, expect, it, vi } from "vitest";
import {
  createCostAttributionPort,
  generateCostReport,
  mergeCfPricing,
  recentCostPeriod,
} from "../src/index.ts";

const NOW = new Date("2026-09-13T12:00:00.000Z");
const GIB = 1024 ** 3;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function focusRow(overrides: Record<string, unknown> = {}) {
  return {
    BillingAccountId: "acct_123",
    ChargeCategory: "Usage",
    ChargePeriodStart: "2026-09-12T00:00:00Z",
    ChargePeriodEnd: "2026-09-13T00:00:00Z",
    ConsumedQuantity: 12,
    ConsumedUnit: "requests",
    ServiceName: "Workers",
    x_BillableMetricId: "workers_requests",
    x_BillableMetricName: "Workers Requests",
    x_ProductFamilyName: "Workers",
    ...overrides,
  };
}

function emptyAccount(): Record<string, unknown[]> {
  return {
    workersInvocationsAdaptive: [],
    durableObjectsInvocationsAdaptiveGroups: [],
    durableObjectsPeriodicGroups: [],
    durableObjectsStorageGroups: [],
    durableObjectsSqlStorageGroups: [],
    kvOperationsAdaptiveGroups: [],
    kvStorageAdaptiveGroups: [],
    r2OperationsAdaptiveGroups: [],
    r2StorageAdaptiveGroups: [],
    d1AnalyticsAdaptiveGroups: [],
    d1StorageAdaptiveGroups: [],
    aiInferenceAdaptiveGroups: [],
    browserRenderingApiAdaptiveGroups: [],
    containersMetricsAdaptiveGroups: [],
  };
}

function analyticsResponse(account: Record<string, unknown>): Response {
  return jsonResponse({ data: { viewer: { accounts: [account] } } });
}

function authorization(init?: RequestInit): string | null {
  return new Headers(init?.headers).get("authorization");
}

function mockCloudflare(options: {
  account?: Record<string, unknown>;
  billing?: (url: URL, init?: RequestInit) => Response | Promise<Response>;
  graphql?: (query: string, init?: RequestInit) => Response | Promise<Response>;
  token?: string;
} = {}) {
  const token = options.token ?? "token";
  const queries: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(authorization(init)).toBe(`Bearer ${token}`);
    expect(url.toString()).not.toContain(token);
    if (url.pathname.includes("/billable/usage")) {
      return options.billing?.(url, init) ?? jsonResponse({ success: true, result: [] });
    }
    expect(url.pathname).toBe("/client/v4/graphql");
    const query = (JSON.parse(String(init?.body)) as { query: string }).query;
    queries.push(query);
    return options.graphql?.(query, init) ?? analyticsResponse(options.account ?? emptyAccount());
  });
  return { fetcher: fetcher as typeof fetch, queries };
}

async function estimate(account: Record<string, unknown>, extra: {
  days?: number;
  pricing?: ReturnType<typeof mergeCfPricing>;
  accountId?: string;
  token?: string;
  now?: Date;
} = {}) {
  const { fetcher, queries } = mockCloudflare({
    account,
    token: extra.token,
  });
  const report = await generateCostReport(
    extra.accountId ?? "acct_123",
    extra.token ?? "token",
    extra.days ?? 2,
    extra.pricing,
    { fetch: fetcher, now: extra.now ?? NOW },
  );
  return { report, queries, fetcher };
}

describe("recentCostPeriod", () => {
  it("counts inclusive UTC dates and clamps fractional or non-positive windows to one day", () => {
    expect(recentCostPeriod(2, NOW)).toEqual({
      start: "2026-09-12",
      end: "2026-09-13",
      days: 2,
    });
    expect(recentCostPeriod(1, new Date("2026-09-13T23:30:00.000Z")).end).toBe("2026-09-13");
    expect(recentCostPeriod(1, new Date("2026-09-14T00:00:00.000Z"))).toEqual({
      start: "2026-09-14",
      end: "2026-09-14",
      days: 1,
    });
    expect(recentCostPeriod(0, NOW).days).toBe(1);
    expect(recentCostPeriod(1.9, NOW).days).toBe(1);
    expect(recentCostPeriod(-4, NOW).days).toBe(1);
  });

  it("rejects a non-finite day count instead of building an invalid date", async () => {
    expect(() => recentCostPeriod(Number.NaN)).toThrow(/finite number/);
    await expect(generateCostReport("acct_123", "token", Number.POSITIVE_INFINITY))
      .rejects.toMatchObject({ name: "CostAttributionError", code: "invalid_query" });
  });
});

describe("Cloudflare price card", () => {
  it("keeps separate KV delete and list rates and merges one rate without dropping the others", () => {
    expect(mergeCfPricing().kv).toEqual({
      read: 0.5,
      write: 5,
      delete: 5,
      list: 5,
      storage_gb: 0.5,
    });
    const merged = mergeCfPricing(undefined, { kv: { delete: 8 } });
    expect(merged.kv.delete).toBe(8);
    expect(merged.kv.read).toBe(0.5);
    expect(mergeCfPricing().kv.delete).toBe(5);
  });
});

describe("provider-billed reports", () => {
  it("sums non-overlapping billable-usage windows and does not call Analytics", async () => {
    const { fetcher, queries } = mockCloudflare({
      billing: (url) => {
        const from = url.searchParams.get("from");
        const amount = from === "2026-08-05" ? 1.25 : from === "2026-09-05" ? 2.5 : 0;
        return jsonResponse({
          success: true,
          result: [focusRow({ BilledCost: amount, BillingCurrency: "USD" })],
        });
      },
    });

    const report = await generateCostReport("acct_123", "token", 40, undefined, {
      fetch: fetcher,
      now: NOW,
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(queries).toEqual([]);
    expect(report).toMatchObject({
      period: { start: "2026-08-05", end: "2026-09-13", days: 40 },
      attribution: { source: "provider_billed", is_invoice_grade: false, data_completeness: "complete" },
      platform_fee: 0,
      total_cost: 3.75,
      total_estimated_cost: 3.75,
    });
  });

  it("keeps a zero provider total and does not add the estimate platform fee", async () => {
    const { fetcher, queries } = mockCloudflare({
      billing: () => jsonResponse({
        success: true,
        result: [focusRow({ BilledCost: 0, BillingCurrency: "USD" })],
      }),
    });

    const report = await generateCostReport("acct_123", "token", 2, undefined, {
      fetch: fetcher,
      now: NOW,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(queries).toEqual([]);
    expect(report.platform_fee).toBe(0);
    expect(report.total_cost).toBe(0);
    expect(report.total_estimated_cost).toBe(0);
  });

  it("groups billed rows by product family", async () => {
    const { fetcher } = mockCloudflare({
      billing: () => jsonResponse({
        success: true,
        result: [
          focusRow({ BilledCost: 1.25, BillingCurrency: "USD", x_ProductFamilyName: "Workers" }),
          focusRow({
            BilledCost: 0.5,
            BillingCurrency: "USD",
            ServiceName: "R2",
            x_ProductFamilyName: "R2",
            x_BillableMetricId: "r2_class_a",
          }),
        ],
      }),
    });

    const report = await generateCostReport("acct_123", "token", 2, undefined, {
      fetch: fetcher,
      now: NOW,
    });

    expect(report.services.workers?.cost).toBeCloseTo(1.25, 6);
    expect(report.services.r2?.cost).toBeCloseTo(0.5, 6);
    expect(report.total_cost).toBeCloseTo(1.75, 6);
    expect(report.platform_fee).toBe(0);
  });

  it("falls back to Analytics when billed rows mix currencies", async () => {
    const { fetcher } = mockCloudflare({
      account: emptyAccount(),
      billing: () => jsonResponse({
        success: true,
        result: [
          focusRow({ BilledCost: 1, BillingCurrency: "USD" }),
          focusRow({ BilledCost: 1, BillingCurrency: "EUR", x_BillableMetricId: "other" }),
        ],
      }),
    });
    const report = await generateCostReport("acct_123", "token", 2, undefined, {
      fetch: fetcher,
      now: NOW,
    });

    expect(report.attribution.source).toBe("estimated");
    expect(report.attribution.warnings).toContain("mixed_billing_currencies");
    expect(report.total_cost).toBeNull();
    expect(report.total_estimated_cost).toBe(5);
  });
});

describe("Analytics estimate fallback", () => {
  it("uses the price card when billable usage is forbidden or rejected", async () => {
    for (const status of [400, 403]) {
      const { fetcher, queries } = mockCloudflare({
        account: emptyAccount(),
        billing: (url) => {
          expect(url.searchParams.get("from")).toBe("2026-09-12");
          expect(url.searchParams.get("to")).toBe("2026-09-13");
          return jsonResponse({ success: false, errors: [{ message: "denied" }] }, status);
        },
      });
      const report = await generateCostReport("acct_123", "token", 2, undefined, {
        fetch: fetcher,
        now: NOW,
      });
      expect(queries.length).toBeGreaterThan(0);
      expect(report).toMatchObject({
        attribution: { source: "estimated", data_completeness: "complete" },
        platform_fee: 5,
        total_cost: null,
        total_estimated_cost: 5,
      });
      expect(report.attribution.warnings).toContain("provider_billing_unavailable");
    }
  });

  it("estimates when billable usage has quantities but no billed cost", async () => {
    const { fetcher } = mockCloudflare({
      account: emptyAccount(),
      billing: () => jsonResponse({ success: true, result: [focusRow()] }),
    });
    const report = await generateCostReport("acct_123", "token", 2, undefined, {
      fetch: fetcher,
      now: NOW,
    });

    expect(report.attribution.source).toBe("estimated");
    expect(report.attribution.warnings).toEqual(expect.arrayContaining([
      "provider_billing_api_alpha",
      "provider_cost_unavailable",
    ]));
    expect(report.attribution.warnings).not.toContain("provider_billing_unavailable");
    expect(report.provider_usage).toMatchObject({ source: "provider_metered", total_billed_cost: null });
    expect(report.total_estimated_cost).toBe(5);
  });

  it("applies the monthly allowance and platform fee to a one-day window", async () => {
    const { report, queries } = await estimate({
      ...emptyAccount(),
      workersInvocationsAdaptive: [{
        sum: { requests: 1, errors: 0, subrequests: 0 },
        quantiles: { cpuTimeP50: 0, cpuTimeP99: 0 },
        dimensions: { scriptName: "main" },
      }],
    }, { days: 1 });

    expect(queries.some((query) => query.includes('date_geq:"2026-09-13"') && query.includes('date_leq:"2026-09-13"'))).toBe(true);
    expect(report.services.workers).toMatchObject({ status: "available", cost: 0 });
    expect(report.platform_fee).toBe(5);
    expect(report.total_estimated_cost).toBe(5);
  });
});

describe("Workers cost", () => {
  it("bills requests and estimated CPU time, not subrequests or the error subset", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      workersInvocationsAdaptive: [{
        sum: { requests: 10_000_000, errors: 9_000_000, subrequests: 50_000_000 },
        quantiles: { cpuTimeP50: 0, cpuTimeP99: 0 },
        dimensions: { scriptName: "main" },
      }],
    });

    expect(report.services.workers).toMatchObject({
      status: "available",
      cost: 0,
      usage: { requests: 10_000_000, errors: 9_000_000, cpu_ms: 0 },
    });
    expect(report.total_estimated_cost).toBe(5);
  });

  it("charges nothing at the included request and CPU boundaries, and rounds a 1-request overage out of the cent total", async () => {
    const atCap = await estimate({
      ...emptyAccount(),
      workersInvocationsAdaptive: [{
        sum: { requests: 10_000_000, errors: 0, subrequests: 0 },
        quantiles: { cpuTimeP50: 3_000, cpuTimeP99: 3_000 },
        dimensions: { scriptName: "main" },
      }],
    });
    expect(atCap.report.services.workers?.usage.cpu_ms).toBeCloseTo(30_000_000, 6);
    expect(atCap.report.services.workers?.cost).toBe(0);
    expect(atCap.report.total_estimated_cost).toBe(5);

    const oneOver = await estimate({
      ...emptyAccount(),
      workersInvocationsAdaptive: [{
        sum: { requests: 10_000_001, errors: 0, subrequests: 0 },
        quantiles: { cpuTimeP50: 0, cpuTimeP99: 0 },
        dimensions: { scriptName: "main" },
      }],
    });
    expect(oneOver.report.services.workers?.cost).toBeCloseTo(0.0000003, 10);
    expect(oneOver.report.total_estimated_cost).toBe(5);
  });

  it("estimates CPU from each group's median instead of the max median times every request", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      workersInvocationsAdaptive: [
        {
          sum: { requests: 1_000_000, errors: 0, subrequests: 0 },
          quantiles: { cpuTimeP50: 31_000, cpuTimeP99: 40_000 },
          dimensions: { scriptName: "hot" },
        },
        {
          sum: { requests: 100, errors: 0, subrequests: 0 },
          quantiles: { cpuTimeP50: 0, cpuTimeP99: 0 },
          dimensions: { scriptName: "cold" },
        },
      ],
    });

    expect(report.services.workers?.usage.cpu_ms).toBeCloseTo(31_000_000, 6);
    expect(report.services.workers?.cost).toBeCloseTo(0.02, 8);
    expect(report.services.workers?.breakdown?.[0]).toMatchObject({ script: "hot" });
    expect(report.total_estimated_cost).toBe(5.02);
  });

  it("keeps request cost when CPU quantiles are missing and withholds a complete total", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      workersInvocationsAdaptive: [{
        sum: { requests: 11_000_000, errors: 1, subrequests: 0 },
        dimensions: { scriptName: "main" },
      }],
    });

    expect(report.services.workers).toMatchObject({
      status: "available",
      cost: 0.3,
      warnings: ["analytics_metric_unmetered:workers.cpu_ms"],
    });
    expect(report.attribution.data_completeness).toBe("partial");
    expect(report.attribution.warnings).toContain("analytics_metric_unmetered:workers.cpu_ms");
    expect(report.total_estimated_cost).toBeNull();
    expect(report.total_cost).toBeNull();
  });

  it.each([Number.NaN, -1])("marks non-finite Workers requests unavailable (%s)", async (requests) => {
    const { report } = await estimate({
      ...emptyAccount(),
      workersInvocationsAdaptive: [{
        sum: { requests, errors: 0, subrequests: 0 },
        quantiles: { cpuTimeP50: 1, cpuTimeP99: 1 },
        dimensions: { scriptName: "main" },
      }],
    });

    expect(report.services.workers).toMatchObject({ status: "unavailable", cost: null, usage: {} });
    expect(report.attribution.data_completeness).toBe("partial");
    expect(report.total_estimated_cost).toBeNull();
    expect(Number.isNaN(report.total_estimated_cost)).toBe(false);
  });

  it("applies a custom request price", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      workersInvocationsAdaptive: [{
        sum: { requests: 12_000_000, errors: 0, subrequests: 0 },
        quantiles: { cpuTimeP50: 0, cpuTimeP99: 0 },
        dimensions: { scriptName: "main" },
      }],
    }, { pricing: mergeCfPricing(undefined, { workers: { requests: 3 } }) });

    expect(report.services.workers?.cost).toBe(6);
    expect(report.services.workers?.included.requests).toBe(10_000_000);
    expect(report.total_estimated_cost).toBe(11);
  });
});

describe("Durable Objects cost", () => {
  it("prices request and storage overage and ignores periodic wall time", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      durableObjectsInvocationsAdaptiveGroups: [{
        sum: { requests: 2_000_000 },
        dimensions: { objectName: "SessionDO" },
      }],
      durableObjectsPeriodicGroups: [{
        sum: { cpuTime: 9_000_000_000_000 },
        max: { wallTime: 9_000_000_000_000, activeTime: 9_000_000_000_000 },
      }],
      durableObjectsStorageGroups: [{ max: { storedBytes: 7 * GIB } }],
      durableObjectsSqlStorageGroups: [{
        sum: { rowsRead: 0, rowsWritten: 0 },
        max: { databaseSizeBytes: 0 },
      }],
    });

    expect(report.services.durable_objects).toMatchObject({
      status: "available",
      cost: 0.55,
      usage: { requests: 2_000_000, storage_gb: 7 },
    });
    expect(report.total_estimated_cost).toBe(5.55);
  });

  it("does not turn a non-finite storage sample into a NaN total", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      durableObjectsStorageGroups: [{ max: { storedBytes: Number.NaN } }],
    });

    expect(report.services.durable_objects).toMatchObject({ status: "unavailable", cost: null });
    expect(report.attribution.data_completeness).toBe("partial");
    expect(report.total_estimated_cost).toBeNull();
  });

  it("drops the whole Durable Objects estimate when one of its datasets fails", async () => {
    const { fetcher } = mockCloudflare({
      graphql: (query) => {
        if (query.includes("durableObjectsSqlStorageGroups")) {
          return jsonResponse({ errors: [{ message: "sql dataset forbidden" }] });
        }
        return analyticsResponse({
          ...emptyAccount(),
          durableObjectsInvocationsAdaptiveGroups: [{
            sum: { requests: 2_000_000 },
            dimensions: { objectName: "SessionDO" },
          }],
        });
      },
    });
    const report = await generateCostReport("acct_123", "token", 2, undefined, {
      fetch: fetcher,
      now: NOW,
    });

    expect(report.services.durable_objects).toMatchObject({ status: "unavailable", cost: null });
    expect(report.total_estimated_cost).toBeNull();
  });
});

describe("KV cost", () => {
  it("gives reads, writes, deletes, and lists separate included amounts", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      kvOperationsAdaptiveGroups: [
        { sum: { requests: 10_000_000 }, dimensions: { actionType: "Read" } },
        { sum: { requests: 1_500_000 }, dimensions: { actionType: "write" } },
        { sum: { requests: 1_500_000 }, dimensions: { actionType: "delete" } },
        { sum: { requests: 1_000_000 }, dimensions: { actionType: "list" } },
      ],
      kvStorageAdaptiveGroups: [{ max: { byteCount: GIB } }],
    });

    expect(report.services.kv).toMatchObject({
      status: "available",
      cost: 5,
      usage: { reads: 10_000_000, writes: 1_500_000, deletes: 1_500_000, lists: 1_000_000 },
      included: { reads: 10_000_000, writes: 1_000_000, deletes: 1_000_000, lists: 1_000_000 },
    });
    expect(report.total_estimated_cost).toBe(10);
  });

  it("uses the KV delete price from the price card", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      kvOperationsAdaptiveGroups: [
        { sum: { requests: 2_000_000 }, dimensions: { actionType: "delete" } },
      ],
    }, { pricing: mergeCfPricing(undefined, { kv: { delete: 10 } }) });

    expect(report.services.kv?.cost).toBe(10);
    expect(report.total_estimated_cost).toBe(15);
  });

  it("prices KV storage from the peak sample", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      kvStorageAdaptiveGroups: [
        { max: { byteCount: 2 * GIB } },
        { max: { byteCount: 0.5 * GIB } },
      ],
    });

    expect(report.services.kv?.usage.storage_gb).toBe(2);
    expect(report.services.kv?.cost).toBeCloseTo(0.5, 8);
    expect(report.total_estimated_cost).toBe(5.5);
  });

  it("does not bill an unknown KV action as a write", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      kvOperationsAdaptiveGroups: [
        { sum: { requests: 100 }, dimensions: { actionType: "archive" } },
      ],
    });

    expect(report.services.kv).toMatchObject({
      cost: 0,
      usage: { reads: 0, writes: 0, deletes: 0, lists: 0, unclassified: 100 },
      warnings: ["analytics_metric_unmetered:kv.unclassified"],
    });
    expect(report.attribution.data_completeness).toBe("partial");
    expect(report.total_estimated_cost).toBeNull();
  });
});

describe("R2 cost", () => {
  it("bills list and upload operations as Class A and leaves deletes and aborts free", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      r2OperationsAdaptiveGroups: [
        { sum: { requests: 500_000 }, dimensions: { actionType: "PutObject", bucketName: "files" } },
        { sum: { requests: 500_000 }, dimensions: { actionType: "ListObjects", bucketName: "files" } },
        { sum: { requests: 500_000 }, dimensions: { actionType: "UploadPart", bucketName: "files" } },
        { sum: { requests: 500_000 }, dimensions: { actionType: "ListBuckets", bucketName: "" } },
        { sum: { requests: 10_000_000 }, dimensions: { actionType: "GetObject", bucketName: "files" } },
        { sum: { requests: 1_000_000 }, dimensions: { actionType: "HeadObject", bucketName: "files" } },
        { sum: { requests: 8_000_000 }, dimensions: { actionType: "DeleteObject", bucketName: "files" } },
        { sum: { requests: 4_000_000 }, dimensions: { actionType: "AbortMultipartUpload", bucketName: "files" } },
        { sum: { requests: 1_000_000 }, dimensions: { actionType: "DeleteBucket", bucketName: "files" } },
      ],
      r2StorageAdaptiveGroups: [{
        max: { payloadSize: 10 * GIB, objectCount: 1 },
        dimensions: { bucketName: "files" },
      }],
    });

    expect(report.services.r2).toMatchObject({
      status: "available",
      cost: 4.86,
      usage: { class_a_ops: 2_000_000, class_b_ops: 11_000_000, free_ops: 13_000_000, storage_gb: 10 },
    });
    expect(report.services.r2?.breakdown?.[0]).toMatchObject({ bucket: "files" });
    expect(report.total_estimated_cost).toBe(9.86);
  });

  it("does not bill an unknown R2 operation as Class B", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      r2OperationsAdaptiveGroups: [
        { sum: { requests: 1 }, dimensions: { actionType: "GetObject", bucketName: "files" } },
        { sum: { requests: 5_000_000 }, dimensions: { actionType: "NotARealOp", bucketName: "files" } },
      ],
    });

    expect(report.services.r2).toMatchObject({
      usage: { class_a_ops: 0, class_b_ops: 1, unclassified_ops: 5_000_000 },
      warnings: ["analytics_metric_unmetered:r2.unclassified"],
    });
    expect(report.attribution.data_completeness).toBe("partial");
    expect(report.total_estimated_cost).toBeNull();
  });

  it("keeps the larger storage sample when the same bucket appears twice", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      r2StorageAdaptiveGroups: [
        { max: { payloadSize: 6 * GIB, objectCount: 1 }, dimensions: { bucketName: "files" } },
        { max: { payloadSize: 8 * GIB, objectCount: 1 }, dimensions: { bucketName: "files" } },
        { max: { payloadSize: 4 * GIB, objectCount: 1 }, dimensions: { bucketName: "logs" } },
      ],
    });

    expect(report.services.r2?.usage.storage_gb).toBe(12);
    expect(report.services.r2?.cost).toBeCloseTo(0.03, 8);
    expect(report.total_estimated_cost).toBe(5.03);
  });
});

describe("D1, Workers AI, Browser Rendering, and Containers", () => {
  it("prices a D1 read overage and keeps an exactly-included write and storage sample at zero", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      d1AnalyticsAdaptiveGroups: [{
        sum: { rowsRead: 25_000_000_000 + 1_000_000, rowsWritten: 50_000_000 },
      }],
      d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 5 * GIB } }],
    });

    expect(report.services.d1?.cost).toBeCloseTo(0.001, 8);
    expect(report.total_estimated_cost).toBe(5);
  });

  it("prices D1 storage above the included gigabytes", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 7 * GIB } }],
    });

    expect(report.services.d1?.cost).toBeCloseTo(1.5, 8);
    expect(report.total_estimated_cost).toBe(6.5);
  });

  it("prices Workers AI neurons with no included quantity", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      aiInferenceAdaptiveGroups: [{
        sum: { neurons: 2_000 },
        dimensions: { modelName: "test-model" },
      }],
    });

    expect(report.services.workers_ai).toMatchObject({
      cost: 0.022,
      usage: { neurons: 2_000 },
      breakdown: [{ model: "test-model", neurons: 2_000 }],
    });
    expect(report.total_estimated_cost).toBe(5.02);
  });

  it("prices Browser Rendering hours above the included ten", async () => {
    const atCap = await estimate({
      ...emptyAccount(),
      browserRenderingApiAdaptiveGroups: [{ sum: { requests: 1, durationMs: 10 * 3_600_000 } }],
    });
    const over = await estimate({
      ...emptyAccount(),
      browserRenderingApiAdaptiveGroups: [{ sum: { requests: 2, durationMs: 12 * 3_600_000 } }],
    });

    expect(atCap.report.services.browser_rendering?.cost).toBe(0);
    expect(over.report.services.browser_rendering?.cost).toBeCloseTo(0.18, 8);
    expect(over.report.total_estimated_cost).toBe(5.18);
  });

  it("prices container CPU overage and ignores disk seconds", async () => {
    const { report } = await estimate({
      ...emptyAccount(),
      containersMetricsAdaptiveGroups: [{
        sum: {
          cpuTimeUs: 23_500 * 1_000_000,
          memoryGiBSeconds: 90_000,
          diskGBSeconds: 1_000_000_000_000,
        },
      }],
    });

    expect(report.services.containers?.cost).toBeCloseTo(0.02, 8);
    expect(report.total_estimated_cost).toBe(5.02);
  });
});

describe("dataset failures", () => {
  it("keeps the other services when one Analytics dataset returns an error", async () => {
    const { fetcher } = mockCloudflare({
      graphql: (query) => {
        if (query.includes("workersInvocationsAdaptive")) {
          return jsonResponse({ errors: [{ message: "dataset forbidden" }] });
        }
        return analyticsResponse({
          ...emptyAccount(),
          d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 7 * GIB } }],
        });
      },
    });
    const report = await generateCostReport("acct_123", "token", 2, undefined, {
      fetch: fetcher,
      now: NOW,
    });

    expect(report.attribution.data_completeness).toBe("partial");
    expect(report.attribution.warnings).toContain("analytics_dataset_unavailable:workers");
    expect(report.services.workers).toMatchObject({ status: "unavailable", cost: null });
    expect(report.services.d1?.cost).toBeCloseTo(1.5, 8);
    expect(report.total_estimated_cost).toBeNull();
    expect(report.platform_fee).toBe(5);
  });

  it("reports the estimate unavailable when every dataset fails", async () => {
    const { fetcher } = mockCloudflare({
      billing: () => jsonResponse({ success: false, errors: [{ message: "forbidden" }] }, 403),
      graphql: () => jsonResponse({ errors: [{ message: "down" }] }, 500),
    });
    const report = await generateCostReport("acct_123", "token", 2, undefined, {
      fetch: fetcher,
      now: NOW,
    });

    expect(report.attribution).toMatchObject({
      source: "estimated",
      data_completeness: "unavailable",
      reconciled_at: null,
    });
    expect(report.total_estimated_cost).toBeNull();
    expect(report.attribution.warnings).toEqual(expect.arrayContaining([
      "provider_billing_unavailable",
      "analytics_dataset_unavailable:workers",
      "analytics_dataset_unavailable:durable_objects",
      "analytics_dataset_unavailable:kv",
      "analytics_dataset_unavailable:r2",
      "analytics_dataset_unavailable:d1",
      "analytics_dataset_unavailable:workers_ai",
      "analytics_dataset_unavailable:browser_rendering",
      "analytics_dataset_unavailable:containers",
    ]));
  });

  it.each([
    ["malformed json", () => new Response("not-json", { status: 200, headers: { "content-type": "text/plain" } })],
    ["no account", () => jsonResponse({ data: { viewer: { accounts: [] } } })],
  ])("marks Workers unavailable on %s", async (_label, respond) => {
    const { fetcher } = mockCloudflare({
      graphql: (query) => query.includes("workersInvocationsAdaptive")
        ? respond()
        : analyticsResponse(emptyAccount()),
    });
    const report = await generateCostReport("acct_123", "token", 2, undefined, {
      fetch: fetcher,
      now: NOW,
    });

    expect(report.services.workers?.status).toBe("unavailable");
    expect(report.attribution.data_completeness).toBe("partial");
    expect(report.total_estimated_cost).toBeNull();
  });
});

describe("query safety", () => {
  it("rejects an invalid period before calling Cloudflare", async () => {
    const fetcher = vi.fn();
    const port = createCostAttributionPort({
      accountId: "acct_123",
      token: "token",
      fetch: fetcher as typeof fetch,
    });

    await expect(port.report({
      period: { start: "2026-02-31", end: "2026-09-13", days: 1 },
      scope: { type: "account", id: "acct_123" },
    })).rejects.toMatchObject({ name: "CostAttributionError", code: "invalid_query" });
    await expect(port.report({
      period: { start: "2026-09-01", end: "2026-09-13", days: 2 },
      scope: { type: "account", id: "acct_123" },
    })).rejects.toMatchObject({ code: "invalid_query" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("escapes an account id before placing it in the GraphQL query", async () => {
    const { fetcher, queries } = mockCloudflare({ account: emptyAccount() });
    const report = await generateCostReport('ac"ct', "token", 2, undefined, {
      fetch: fetcher,
      now: NOW,
    });

    const billingUrl = String(fetcher.mock.calls[0]?.[0]);
    expect(billingUrl).toContain("/accounts/ac%22ct/billable/usage");
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query).toContain('"ac\\"ct"');
      expect(query).not.toContain('accountTag:"ac"ct"');
    }
    expect(report.scope).toEqual({ type: "account", id: 'ac"ct' });
    expect(report.total_estimated_cost).toBe(5);
  });

  it("rejects a scope that is not the configured account", async () => {
    const fetcher = vi.fn();
    const port = createCostAttributionPort({
      accountId: "acct_123",
      token: "token",
      fetch: fetcher as typeof fetch,
    });

    await expect(port.report({
      period: { start: "2026-09-13", end: "2026-09-13", days: 1 },
      scope: { type: "account", id: "other" },
    })).rejects.toMatchObject({ name: "CostAttributionError", code: "scope_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a report whose caller already aborted, without calling Cloudflare", async () => {
    const abort = new AbortController();
    abort.abort();
    const fetcher = vi.fn();
    await expect(generateCostReport("acct_123", "token", 2, undefined, {
      fetch: fetcher as typeof fetch,
      now: NOW,
      signal: abort.signal,
    })).rejects.toMatchObject({ name: "CostAttributionError", code: "provider_unavailable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects when the caller aborts during the Analytics fallback", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("graphql")) {
        abort.abort();
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return jsonResponse({ success: true, result: [focusRow()] });
    });

    await expect(generateCostReport("acct_123", "token", 2, undefined, {
      fetch: fetcher as typeof fetch,
      now: NOW,
      signal: abort.signal,
    })).rejects.toMatchObject({ name: "CostAttributionError", code: "provider_unavailable" });
  });
});

describe("combined Analytics fixture", () => {
  it("prices every supported dataset into one complete estimate", async () => {
    const { report } = await estimate({
      workersInvocationsAdaptive: [{
        sum: { requests: 11_000_000, errors: 2, subrequests: 0 },
        quantiles: { cpuTimeP50: 1, cpuTimeP99: 3 },
        dimensions: { scriptName: "main" },
      }],
      durableObjectsInvocationsAdaptiveGroups: [{
        sum: { requests: 2_000_000 },
        dimensions: { objectName: "SessionDO" },
      }],
      durableObjectsPeriodicGroups: [{
        sum: { cpuTime: 0 },
        max: { wallTime: 0, activeTime: 0 },
      }],
      durableObjectsStorageGroups: [{ max: { storedBytes: 6 * GIB } }],
      durableObjectsSqlStorageGroups: [{
        sum: { rowsRead: 0, rowsWritten: 0 },
        max: { databaseSizeBytes: 0 },
      }],
      kvOperationsAdaptiveGroups: [{
        sum: { requests: 11_000_000 },
        dimensions: { actionType: "read" },
      }],
      kvStorageAdaptiveGroups: [{ max: { byteCount: GIB } }],
      r2OperationsAdaptiveGroups: [{
        sum: { requests: 2_000_000 },
        dimensions: { actionType: "PutObject", bucketName: "files" },
      }],
      r2StorageAdaptiveGroups: [{
        max: { payloadSize: 10 * GIB, objectCount: 1 },
        dimensions: { bucketName: "files" },
      }],
      d1AnalyticsAdaptiveGroups: [{
        sum: { rowsRead: 26_000_000_000, rowsWritten: 0 },
      }],
      d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 5 * GIB } }],
      aiInferenceAdaptiveGroups: [{
        sum: { neurons: 1_000 },
        dimensions: { modelName: "test-model" },
      }],
      browserRenderingApiAdaptiveGroups: [{
        sum: { requests: 1, durationMs: 11 * 3_600_000 },
      }],
      containersMetricsAdaptiveGroups: [{
        sum: {
          cpuTimeUs: 23_500 * 1_000_000,
          memoryGiBSeconds: 90_000,
          diskGBSeconds: 0,
        },
      }],
    });

    expect(report.attribution).toMatchObject({
      source: "estimated",
      data_completeness: "complete",
    });
    expect(report.total_cost).toBeNull();
    expect(report.total_estimated_cost).toBe(11.77);
    expect(report.services).toMatchObject({
      workers: { status: "available", cost: 0.3 },
      durable_objects: { status: "available", cost: 0.35 },
      kv: { status: "available", cost: 0.5 },
      r2: { status: "available", cost: 4.5 },
      d1: { status: "available", cost: 1 },
      workers_ai: { status: "available", cost: 0.011 },
      browser_rendering: { status: "available", cost: 0.09 },
      containers: { status: "available", cost: 0.02 },
    });
  });
});
