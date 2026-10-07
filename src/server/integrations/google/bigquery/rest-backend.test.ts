import { describe, expect, it, vi } from "vitest";

import { GoogleApiError, googleErrorFromResponse } from "../errors";
import { classifyBigQueryError } from "./errors";
import { createRestBackend, jobLabelValue } from "./rest-backend";
import type { BqQueryRequest } from "./types";

// Bu dosyanın kanıtladığı: istek gövdesi sözleşmedeki gibi kurulur, ücretli
// jobs.query POST'u retry:false ile gider (yoklama GET'leri değil), iş
// bitene kadar yoklanır, sayfalar birleşir, hücreler şemaya göre çözülür,
// etiket temizlenir ve hatalar sınıflanır.

type Call = {
  url: string;
  init: RequestInit;
  options: { kind?: string; retry?: boolean } | undefined;
};

function harness(responses: unknown[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchJson = vi.fn(
    async (url: string, init: RequestInit = {}, options?: Call["options"]) => {
      calls.push({ url, init, options });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  );
  const sleep = vi.fn(async () => undefined);
  let nowMs = 1_000_000;
  const backend = createRestBackend({
    fetchJson: fetchJson as never,
    sleep,
    now: () => nowMs,
  });
  return {
    backend,
    calls,
    sleep,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function request(overrides: Partial<BqQueryRequest> = {}): BqQueryRequest {
  return {
    purpose: "gsc.period.query",
    projectId: "my-project-1",
    location: "EU",
    sql: "SELECT a FROM `my-project-1.d.t` WHERE x = @x",
    params: [
      { name: "x", type: "INT64", value: 5 },
      { name: "d", type: "DATE", value: "2026-10-01" },
    ],
    maxBytesBilled: 10_485_760,
    maxRows: 100,
    requestId: "req-1",
    ...overrides,
  };
}

const SCHEMA = {
  fields: [
    { name: "q", type: "STRING" },
    { name: "n", type: "INTEGER" },
    { name: "f", type: "FLOAT" },
    { name: "b", type: "BOOLEAN" },
    { name: "d", type: "DATE" },
    { name: "o", type: "RECORD" },
  ],
};

function row(...values: unknown[]) {
  return { f: values.map((v) => ({ v })) };
}

const JOB = { projectId: "my-project-1", jobId: "job_1", location: "EU" };

describe("query request", () => {
  it("posts the documented body with retry disabled", async () => {
    const { backend, calls } = harness([
      {
        jobComplete: true,
        jobReference: JOB,
        schema: SCHEMA,
        rows: [],
        totalRows: "0",
        totalBytesProcessed: "123",
      },
      { statistics: { query: { totalBytesBilled: "10485760" } } },
    ]);
    const result = await backend.query(request(), "tok");

    const post = calls[0] as Call;
    expect(post.url).toBe(
      "https://bigquery.googleapis.com/bigquery/v2/projects/my-project-1/queries",
    );
    expect(post.init.method).toBe("POST");
    expect((post.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
    expect(post.options).toEqual({ kind: "report", retry: false });
    const body = JSON.parse(post.init.body as string);
    expect(body).toMatchObject({
      useLegacySql: false,
      parameterMode: "NAMED",
      maximumBytesBilled: "10485760",
      maxResults: 100,
      timeoutMs: 20000,
      location: "EU",
      requestId: "req-1",
      labels: { app: "agentelse", purpose: "gsc_period_query" },
    });
    expect(body.queryParameters).toEqual([
      {
        name: "x",
        parameterType: { type: "INT64" },
        parameterValue: { value: "5" },
      },
      {
        name: "d",
        parameterType: { type: "DATE" },
        parameterValue: { value: "2026-10-01" },
      },
    ]);
    expect(body.dryRun).toBeUndefined();
    expect(result.bytesProcessed).toBe(123);
    expect(result.bytesBilled).toBe(10_485_760);
  });

  it("omits location when the request has none", async () => {
    const { backend, calls } = harness([
      { jobComplete: true, schema: SCHEMA, rows: [], totalRows: "0" },
    ]);
    await backend.query(request({ location: null }), "tok");
    const body = JSON.parse((calls[0] as Call).init.body as string);
    expect("location" in body).toBe(false);
  });
});

describe("polling and paging", () => {
  it("polls with default retry until the job completes", async () => {
    const { backend, calls, sleep } = harness([
      { jobComplete: false, jobReference: JOB },
      { jobComplete: false, jobReference: JOB },
      {
        jobComplete: true,
        jobReference: JOB,
        schema: SCHEMA,
        rows: [],
        totalRows: "0",
      },
      { statistics: {} },
    ]);
    await backend.query(request(), "tok");
    const posts = calls.filter((c) => c.init.method === "POST");
    const gets = calls.filter((c) => c.init.method !== "POST");
    expect(posts).toHaveLength(1);
    expect(gets).toHaveLength(3);
    for (const get of gets) {
      expect(get.options).toEqual({ kind: "report" });
    }
    expect(gets[0]?.url).toContain("/queries/job_1?");
    expect(gets[0]?.url).toContain("location=EU");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("gives up with TIMEOUT when the job never completes in time", async () => {
    const h = harness([
      { jobComplete: false, jobReference: JOB },
      { jobComplete: false, jobReference: JOB },
    ]);
    const pending = h.backend.query(request({ timeoutMs: 5000 }), "tok");
    // İlk yoklamadan önce süre dolar
    h.advance(6000);
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("cancels the job (best effort) when it times out so it is not billed further", async () => {
    const h = harness([{ jobComplete: false, jobReference: JOB }]);
    const pending = h.backend.query(request({ timeoutMs: 5000 }), "tok");
    h.advance(6000);
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
    const cancel = h.calls.find((call) => call.url.includes("/jobs/job_1/cancel"));
    expect(cancel?.init.method).toBe("POST");
    expect(cancel?.url).toContain("location=EU");
  });

  it("still reports TIMEOUT when the cancel call itself fails", async () => {
    const h = harness([{ jobComplete: false, jobReference: JOB }, new Error("cancel down")]);
    const pending = h.backend.query(request({ timeoutMs: 5000 }), "tok");
    h.advance(6000);
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("reads further pages up to maxRows and flags truncation", async () => {
    const { backend, calls } = harness([
      {
        jobComplete: true,
        jobReference: JOB,
        schema: SCHEMA,
        rows: [row("a", "1", "1.5", "true", "2026-10-01", null)],
        totalRows: "5",
        pageToken: "p2",
      },
      {
        rows: [row("b", "2", "2.5", "false", "2026-10-02", null)],
        pageToken: "p3",
      },
      { statistics: {} },
    ]);
    const result = await backend.query(request({ maxRows: 2 }), "tok");
    expect(result.rows).toHaveLength(2);
    expect(result.totalRows).toBe(5);
    expect(result.truncated).toBe(true);
    const page = calls[1] as Call;
    expect(page.url).toContain("pageToken=p2");
    expect(page.url).toContain("maxResults=1");
  });

  it("is not truncated when every row was read", async () => {
    const { backend } = harness([
      {
        jobComplete: true,
        jobReference: JOB,
        schema: SCHEMA,
        rows: [row("a", "1", "1", "true", "2026-10-01", null)],
        totalRows: "1",
      },
      { statistics: {} },
    ]);
    const result = await backend.query(request(), "tok");
    expect(result.truncated).toBe(false);
  });
});

describe("cell decoding", () => {
  it("decodes cells by schema type and keeps null", async () => {
    const { backend } = harness([
      {
        jobComplete: true,
        jobReference: JOB,
        schema: SCHEMA,
        rows: [
          row("hello", "42", "0.25", "true", "2026-10-01", { a: 1 }),
          row(null, null, null, null, null, null),
          row("x", "7", "1e3", "false", "2026-10-02", null),
        ],
        totalRows: "3",
        cacheHit: true,
      },
      { statistics: {} },
    ]);
    const result = await backend.query(request(), "tok");
    expect(result.columns.map((c) => c.type)).toEqual([
      "STRING",
      "INTEGER",
      "FLOAT",
      "BOOLEAN",
      "DATE",
      "OTHER",
    ]);
    expect(result.rows[0]).toEqual([
      "hello",
      42,
      0.25,
      true,
      "2026-10-01",
      '{"a":1}',
    ]);
    expect(result.rows[1]).toEqual([null, null, null, null, null, null]);
    expect(result.rows[2]).toEqual(["x", 7, 1000, false, "2026-10-02", null]);
    expect(result.cacheHit).toBe(true);
  });

  it("does not fail the query when the billed bytes lookup fails", async () => {
    const { backend } = harness([
      {
        jobComplete: true,
        jobReference: JOB,
        schema: SCHEMA,
        rows: [],
        totalRows: "0",
      },
      new GoogleApiError("boom", undefined, { httpStatus: 500 }),
    ]);
    const result = await backend.query(request(), "tok");
    expect(result.bytesBilled).toBeNull();
  });
});

describe("dry run, tables and datasets", () => {
  it("sends dryRun true with retry disabled and returns the bytes", async () => {
    const { backend, calls } = harness([
      { jobComplete: true, totalBytesProcessed: "2400000000" },
    ]);
    const out = await backend.dryRun(request(), "tok");
    expect(out).toEqual({ bytesProcessed: 2_400_000_000 });
    const call = calls[0] as Call;
    expect(JSON.parse(call.init.body as string).dryRun).toBe(true);
    expect(call.options).toEqual({ kind: "report", retry: false });
  });

  it("reads table info from the tables endpoint", async () => {
    const { backend, calls } = harness([
      {
        numRows: "1000",
        numBytes: "5000",
        location: "EU",
        timePartitioning: { type: "DAY", field: "data_date" },
      },
    ]);
    const info = await backend.getTable(
      { projectId: "my-project-1", dataset: "searchconsole", table: "t1" },
      "tok",
    );
    expect(info).toEqual({
      numRows: 1000,
      sizeBytes: 5000,
      location: "EU",
      partitionField: "data_date",
    });
    expect((calls[0] as Call).url).toBe(
      "https://bigquery.googleapis.com/bigquery/v2/projects/my-project-1/datasets/searchconsole/tables/t1",
    );
  });

  it("returns null fields for a table without partitioning", async () => {
    const { backend } = harness([{}]);
    const info = await backend.getTable(
      { projectId: "my-project-1", dataset: "d", table: "t" },
      "tok",
    );
    expect(info).toEqual({
      numRows: null,
      sizeBytes: null,
      location: null,
      partitionField: null,
    });
  });

  it("reads dataset location and refuses invalid ids before any request", async () => {
    const { backend, calls } = harness([{ location: "US" }]);
    expect(
      await backend.getDataset(
        { projectId: "my-project-1", dataset: "d1" },
        "tok",
      ),
    ).toEqual({ location: "US" });
    expect((calls[0] as Call).url).toBe(
      "https://bigquery.googleapis.com/bigquery/v2/projects/my-project-1/datasets/d1",
    );
    await expect(
      backend.getDataset({ projectId: "my-project-1", dataset: "a/b" }, "tok"),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      backend.getTable(
        { projectId: "my-project-1", dataset: "d", table: "t`" },
        "tok",
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(calls).toHaveLength(1);
  });
});

describe("job labels and error mapping", () => {
  it("sanitises the purpose into a valid label value", () => {
    expect(jobLabelValue("gsc.period.query")).toBe("gsc_period_query");
    expect(jobLabelValue("GA.Daily Report")).toBe("ga_daily_report");
    expect(jobLabelValue("a".repeat(100))).toHaveLength(63);
    expect(jobLabelValue("")).toBe("unknown");
    expect(jobLabelValue("ga.daily")).toMatch(/^[a-z0-9_-]+$/);
  });

  it("lets Google errors through for the client to classify", async () => {
    const forbidden = googleErrorFromResponse(403, {
      error: {
        code: 403,
        message: "Access Denied",
        errors: [{ reason: "accessDenied" }],
      },
    });
    const { backend } = harness([forbidden]);
    const error = await backend
      .query(request(), "tok")
      .catch((e: unknown) => e);
    expect(error).toBe(forbidden);
    expect(classifyBigQueryError(error).code).toBe("NO_ACCESS");
  });
});
