import "server-only";

import { getEnv } from "@/lib/env";
import { putAsset } from "@/server/storage/asset-storage";

// fal.ai image generation — an additional, opt-in provider alongside
// openai-image-client.ts (see creative-image.ts). Every fal model shares
// the same queue REST shape regardless of which of the 50+ endpoints is
// called, so one client covers the whole curated list in
// fal-image-models.ts. Raw fetch, no SDK — same choice openai-client.ts
// made ("No SDK dependency") for the same reason: one fewer dependency to
// track, and the queue API is simple enough not to need one.
//
// Flow (fal.ai's documented queue pattern — submit is fire-and-return,
// generation happens async): POST submits and returns immediately with a
// request_id + status/response URLs; we poll the status URL until
// COMPLETED, then fetch the result. fal's own docs recommend downloading
// output URLs immediately — its CDN links aren't guaranteed permanent —
// so the result image is fetched and stored via the same putAsset() every
// other provider uses, never left as a bare fal.media URL.

const QUEUE_BASE_URL = "https://queue.fal.run";
// Generation itself (not just the HTTP call) can take tens of seconds for
// slower models in the curated list (e.g. clarity-upscaler) — this bounds
// the whole submit+poll+fetch cycle, same order of magnitude as
// openai-image-client.ts's FETCH_TIMEOUT_MS.
const TOTAL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

export type GeneratedFalImage = {
  storageKey: string;
  filename: string;
  mimeType: string;
  size: number;
  provider: "fal";
};

export function isFalImageConfigured(): boolean {
  return Boolean(getEnv().FAL_API_KEY);
}

type FalSubmitResponse = {
  request_id?: string;
  status_url?: string;
  response_url?: string;
  error?: string;
};

type FalStatusResponse = {
  status?: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
};

type FalImageResult = {
  images?: Array<{ url?: string; content_type?: string }>;
  detail?: unknown;
};

function authHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Key ${apiKey}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every failure branch below used to log only the HTTP status code — e.g.
// "[fal-image] result fetch failed: 422" — with no way to tell WHY without
// reproducing it. fal's error responses (a validation error naming the
// bad field, a moderation rejection, a per-model input mismatch) are in
// the body; this logs it (truncated — some error payloads embed the full
// request echo) instead of throwing it away.
async function logHttpFailure(
  prefix: string,
  response: Response,
): Promise<void> {
  const bodyText = await response.text().catch(() => "");
  console.error(
    `[fal-image] ${prefix}: ${response.status}`,
    bodyText.slice(0, 2000),
  );
}

async function storeResult(
  result: FalImageResult,
): Promise<GeneratedFalImage | null> {
  const image = result.images?.[0];
  if (!image?.url) {
    console.error("[fal-image] no image in result", result.detail ?? "");
    return null;
  }

  const response = await fetch(image.url);
  if (!response.ok) {
    console.error(
      "[fal-image] failed to download result image",
      response.status,
    );
    return null;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType = image.content_type ?? "image/png";
  const ext = mimeType.split("/")[1] ?? "png";
  const { storageKey, filename } = await putAsset(buffer, ext, mimeType);

  return {
    storageKey,
    filename,
    mimeType,
    size: buffer.byteLength,
    provider: "fal",
  };
}

// baseImage/referenceImage: sent as a data-URI (fal accepts either a data
// URI or a hosted URL for image inputs) — only meaningful for models with
// supportsImageInput: true (see fal-image-models.ts); the caller is
// responsible for only passing one when the chosen model accepts it.
//
// imageSize is passed as fal's `image_size: {width, height}` object, which
// FLUX-family endpoints accept directly. Other curated models (Recraft,
// Ideogram, Bria, Clarity) use different size/aspect-ratio field names and
// will simply ignore this field — a deliberate simplification: fal's queue
// API ignores unrecognized input fields rather than rejecting the request,
// and normalizing dimensions is minor compared to letting a small,
// hand-picked model list stay hand-picked (see fal-image-models.ts).
export async function generateFalImage(
  endpointId: string,
  prompt: string,
  inputImage?: { data: string; mimeType: string },
  imageSize?: { width: number; height: number },
): Promise<GeneratedFalImage | null> {
  const env = getEnv();
  if (!env.FAL_API_KEY) return null;

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  try {
    const body: Record<string, unknown> = { prompt };
    if (imageSize) body.image_size = imageSize;
    if (inputImage) {
      body.image_url = `data:${inputImage.mimeType};base64,${inputImage.data}`;
    }

    const submitResponse = await fetch(`${QUEUE_BASE_URL}/${endpointId}`, {
      method: "POST",
      headers: authHeaders(env.FAL_API_KEY),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
    });
    if (!submitResponse.ok) {
      await logHttpFailure(`submit failed (${endpointId})`, submitResponse);
      return null;
    }
    const submitPayload = (await submitResponse.json()) as FalSubmitResponse;
    if (!submitPayload.status_url || !submitPayload.response_url) {
      console.error(
        `[fal-image] submit ok but missing status_url/response_url (${endpointId})`,
        JSON.stringify(submitPayload).slice(0, 2000),
      );
      return null;
    }
    const { status_url: statusUrl, response_url: responseUrl } = submitPayload;

    while (Date.now() < deadline) {
      const statusResponse = await fetch(statusUrl, {
        headers: authHeaders(env.FAL_API_KEY),
        signal: AbortSignal.timeout(30_000),
      });
      if (!statusResponse.ok) {
        await logHttpFailure(
          `status check failed (${endpointId})`,
          statusResponse,
        );
        return null;
      }
      const statusPayload = (await statusResponse.json()) as FalStatusResponse;
      if (statusPayload.status === "COMPLETED") {
        const resultResponse = await fetch(responseUrl, {
          headers: authHeaders(env.FAL_API_KEY),
          signal: AbortSignal.timeout(30_000),
        });
        if (!resultResponse.ok) {
          await logHttpFailure(
            `result fetch failed (${endpointId})`,
            resultResponse,
          );
          return null;
        }
        return storeResult((await resultResponse.json()) as FalImageResult);
      }
      await sleep(POLL_INTERVAL_MS);
    }

    console.error(`[fal-image] timed out after ${TOTAL_TIMEOUT_MS}ms`);
    return null;
  } catch (error) {
    console.error("[fal-image] generation failed", error);
    return null;
  }
}
