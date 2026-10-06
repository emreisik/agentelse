import "server-only";

import { metaFetch } from "./graph";
import { GRAPH_API_VERSION, GRAPH_HOST } from "./version";

// Graph batch isteği (docs/meta-ads-plan.md §3.1, F8): en çok 50 GET tek HTTP
// çağrısında. Her alt yanıt kendi durum koduyla döner; alt isteğin hatası
// yalnız onu etkiler. Meta kotası alt istek başına sayılır.

const MAX_PER_BATCH = 50;

export type BatchItem<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; message: string };

export async function metaBatchGet<T>(
  paths: readonly string[],
  accessToken: string,
): Promise<BatchItem<T>[]> {
  const out: BatchItem<T>[] = [];
  for (let start = 0; start < paths.length; start += MAX_PER_BATCH) {
    const chunk = paths.slice(start, start + MAX_PER_BATCH);
    const body = new URLSearchParams({
      access_token: accessToken,
      include_headers: "false",
      batch: JSON.stringify(
        chunk.map((path) => ({
          method: "GET",
          relative_url: `${GRAPH_API_VERSION}/${path.replace(/^\//, "")}`,
        })),
      ),
    });
    const responses = await metaFetch<({ code?: number; body?: string } | null)[]>(
      `${GRAPH_HOST}/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      },
    );
    for (let index = 0; index < chunk.length; index += 1) {
      const response = responses[index];
      if (!response) {
        out.push({ ok: false, status: 0, message: "No response (timed out in the batch)" });
        continue;
      }
      let parsed: unknown = null;
      try {
        parsed = response.body ? JSON.parse(response.body) : null;
      } catch {
        parsed = null;
      }
      const status = response.code ?? 0;
      if (status >= 200 && status < 300) {
        out.push({ ok: true, body: parsed as T });
      } else {
        const message =
          (parsed as { error?: { message?: string } } | null)?.error?.message ??
          `Meta answered ${status}`;
        out.push({ ok: false, status, message });
      }
    }
  }
  return out;
}
