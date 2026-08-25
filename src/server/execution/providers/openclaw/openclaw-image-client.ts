import "server-only";

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

import { getEnv, isIntegrationConfigured } from "@/lib/env";
import { putAsset } from "@/server/storage/asset-storage";

const execFileAsync = promisify(execFile);

// Confirmed against a live gateway (`openclaw infer image generate --json`,
// openai/gpt-image-2): unlike `openclaw agent`'s deeply-nested envelope,
// this direct provider CLI returns a flat, already-useful shape — no
// separate parsing/normalizer layer needed like openclaw-schemas.ts.
const inferImageGenerateResponseSchema = z
  .object({
    ok: z.boolean(),
    outputs: z
      .array(
        z
          .object({
            path: z.string(),
            mimeType: z.string(),
            size: z.number(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type GeneratedCreativeImage = {
  storageKey: string;
  filename: string;
  mimeType: string;
  size: number;
  provider: "openclaw";
};

export function isOpenClawImageConfigured(): boolean {
  return isIntegrationConfigured("OPENCLAW");
}

// Direct, non-conversational image generation via `openclaw infer image
// generate` — a direct HTTP call to the provider, with no agent/session and
// no Gateway RPC equivalent (confirmed: no `infer.*`/`image.*` method exists
// on the Gateway's WS surface). Stays on the CLI subprocess for this reason,
// unlike agent listing/provisioning which moved to the Gateway. Returns
// null on any failure — callers fall back to the existing mock-placeholder
// behavior rather than breaking creative generation.
export async function generateCreativeImageAsset(
  prompt: string,
  imageSize?: { width: number; height: number },
): Promise<GeneratedCreativeImage | null> {
  const env = getEnv();
  if (!env.OPENCLAW_CLI_PATH) return null;

  // The CLI can only write to a real filesystem path — it has no concept of
  // R2 — so its output goes to a scratch temp file first, then gets read
  // into a buffer and handed to putAsset() (disk or R2, whichever is
  // configured) like every other generator.
  const outputPath = path.join(tmpdir(), `${randomUUID()}.png`);

  const args = [
    "infer",
    "image",
    "generate",
    "--prompt",
    prompt,
    "--output",
    outputPath,
    "--model",
    env.OPENCLAW_IMAGE_MODEL,
    "--size",
    imageSize ? `${imageSize.width}x${imageSize.height}` : "1024x1024",
    "--json",
    "--timeout-ms",
    "60000",
  ];

  const command = env.OPENCLAW_NODE_PATH || env.OPENCLAW_CLI_PATH;
  const commandArgs = env.OPENCLAW_NODE_PATH
    ? [env.OPENCLAW_CLI_PATH, ...args]
    : args;

  try {
    const { stdout } = await execFileAsync(command, commandArgs, {
      timeout: 75_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const parsed = inferImageGenerateResponseSchema.safeParse(
      JSON.parse(stdout),
    );
    if (!parsed.success || !parsed.data.ok) return null;

    const output = parsed.data.outputs?.[0];
    if (!output) return null;

    const buffer = await readFile(outputPath);
    const { storageKey, filename } = await putAsset(
      buffer,
      "png",
      output.mimeType,
    );

    return {
      storageKey,
      filename,
      mimeType: output.mimeType,
      size: output.size,
      provider: "openclaw",
    };
  } catch (error) {
    console.error("[openclaw-image-client] image generation failed", error);
    return null;
  } finally {
    await rm(outputPath, { force: true });
  }
}
