import { describe, expect, it } from "vitest";

import { BigQueryError } from "./errors";
import {
  assertReadOnlySql,
  bqTable,
  isValidDatasetId,
  isValidGcpProjectId,
  isValidTableId,
} from "./identifiers";

// Bu dosyanın kanıtladığı: SQL'e yalnız doğrulanmış tanımlayıcı girer ve
// yazan ya da çok ifadeli SQL hiçbir zaman istemciden geçmez.

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof BigQueryError ? error.code : "OTHER";
  }
}

describe("identifier validation", () => {
  it("accepts normal Cloud project ids", () => {
    expect(isValidGcpProjectId("my-project-123")).toBe(true);
    expect(isValidGcpProjectId("abcde")).toBe(false);
    expect(isValidGcpProjectId("abcdef")).toBe(true);
  });

  it("refuses uppercase, domain-scoped, too short and dash-ended ids", () => {
    expect(isValidGcpProjectId("My-Project")).toBe(false);
    expect(isValidGcpProjectId("example.com:my-project")).toBe(false);
    expect(isValidGcpProjectId("abc")).toBe(false);
    expect(isValidGcpProjectId("my-project-")).toBe(false);
    expect(isValidGcpProjectId("1project")).toBe(false);
    expect(isValidGcpProjectId("a".repeat(31))).toBe(false);
  });

  it("validates dataset and table ids", () => {
    expect(isValidDatasetId("searchconsole")).toBe(true);
    expect(isValidDatasetId("analytics_123456")).toBe(true);
    expect(isValidDatasetId("has-dash")).toBe(false);
    expect(isValidDatasetId("")).toBe(false);
    expect(isValidTableId("searchdata_site_impression")).toBe(true);
    expect(isValidTableId("events_*")).toBe(false);
  });
});

describe("bqTable", () => {
  it("quotes a valid table path", () => {
    expect(
      bqTable({
        projectId: "my-project-1",
        dataset: "searchconsole",
        table: "searchdata_site_impression",
      }),
    ).toBe("`my-project-1.searchconsole.searchdata_site_impression`");
  });

  it("throws INVALID_REQUEST for injection attempts in every part", () => {
    const base = {
      projectId: "my-project-1",
      dataset: "searchconsole",
      table: "searchdata_site_impression",
    };
    for (const bad of ["a`b", "a.b", "a b", "a;b", "a'b", "a-b$"]) {
      expect(code(() => bqTable({ ...base, dataset: bad }))).toBe(
        "INVALID_REQUEST",
      );
      expect(code(() => bqTable({ ...base, table: bad }))).toBe(
        "INVALID_REQUEST",
      );
    }
    expect(code(() => bqTable({ ...base, projectId: "x`; DROP" }))).toBe(
      "INVALID_REQUEST",
    );
  });
});

describe("assertReadOnlySql", () => {
  it("accepts a comment line followed by SELECT or WITH", () => {
    expect(() =>
      assertReadOnlySql("-- agentelse:gsc.sites\nSELECT a FROM `p.d.t`"),
    ).not.toThrow();
    expect(() =>
      assertReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x;"),
    ).not.toThrow();
    expect(() => assertReadOnlySql("  select 1")).not.toThrow();
  });

  it("rejects writes, scripts and multiple statements", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "DROP TABLE t",
      "SELECT 1; SELECT 2",
      "SELECT 1; DROP TABLE t",
      "SELECT 1 UNION ALL SELECT 2; DELETE FROM t WHERE true",
      "CREATE TABLE t AS SELECT 1",
      "EXPORT DATA OPTIONS(uri='x') AS SELECT 1",
      "",
      "-- only a comment",
    ]) {
      expect(code(() => assertReadOnlySql(sql)), sql).toBe("INVALID_REQUEST");
    }
  });

  it("rejects write keywords outside quotes but not inside them", () => {
    expect(
      code(() => assertReadOnlySql("SELECT 1 FROM t WHERE x IN (SELECT 1) AND DELETE")),
    ).toBe("INVALID_REQUEST");
    expect(() =>
      assertReadOnlySql("SELECT a FROM t WHERE q = 'delete; drop table'"),
    ).not.toThrow();
    expect(() =>
      assertReadOnlySql('SELECT a FROM t WHERE q = "update"'),
    ).not.toThrow();
    expect(() =>
      assertReadOnlySql("SELECT a FROM `p.d.drop_log`"),
    ).not.toThrow();
  });

  it("rejects unterminated quotes and comment-hidden tricks", () => {
    expect(code(() => assertReadOnlySql("SELECT 'abc"))).toBe(
      "INVALID_REQUEST",
    );
    expect(code(() => assertReadOnlySql("SELECT 1 /* never closed"))).toBe(
      "INVALID_REQUEST",
    );
    // Yorum satırı sonrası ikinci ifade
    expect(
      code(() => assertReadOnlySql("SELECT 1 -- ok\n; DROP TABLE t")),
    ).toBe("INVALID_REQUEST");
  });
});
