import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

import { getEnv, isIntegrationConfigured } from "@/lib/env";

// Single storage abstraction for every Asset-backed file in the app. Two
// schemes coexist in storageKey values: `local-asset://<file>` (disk under
// storage/assets/ — the only backend before R2, and still the fallback when
// R2 isn't configured, e.g. local dev without R2 keys) and `r2://<key>`
// (Cloudflare R2, S3-compatible). WHICH scheme a NEW write uses is decided
// once, here, by isIntegrationConfigured("R2"); reads/deletes/overwrites
// dispatch off the scheme already present on the storageKey being passed in,
// so pre-existing local-asset:// rows keep working after R2 is turned on.
const LOCAL_ASSET_SCHEME = "local-asset://";
const R2_SCHEME = "r2://";
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");
// Every filename/key we ever generate is `${randomUUID()}.<ext>` (see
// putAsset) — reject anything else outright rather than resolving it
// against the filesystem. Defense in depth: storageKey always originates
// from our own writes, never directly from user input, but this is the one
// place that guarantee gets enforced for every reader instead of being
// re-implemented (and sometimes forgotten — see the missing video
// extensions bug this replaced) per call site.
const SAFE_KEY = /^[a-zA-Z0-9-]+\.[a-zA-Z0-9]+$/;

function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key)) {
    throw new Error(`Unsafe asset key: ${key}`);
  }
}

let client: S3Client | null = null;

function getR2Client(): S3Client {
  if (!client) {
    const env = getEnv();
    client = new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

function bucketName(): string {
  return getEnv().R2_BUCKET_NAME;
}

async function writeLocal(filename: string, buffer: Buffer): Promise<void> {
  await mkdir(LOCAL_ASSETS_DIR, { recursive: true });
  await writeFile(path.join(LOCAL_ASSETS_DIR, filename), buffer);
}

async function readLocal(filename: string): Promise<Buffer> {
  return readFile(path.join(LOCAL_ASSETS_DIR, filename));
}

async function putR2(
  key: string,
  buffer: Buffer,
  mimeType: string,
): Promise<void> {
  await getR2Client().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }),
  );
}

async function getR2(key: string): Promise<Buffer> {
  const result = await getR2Client().send(
    new GetObjectCommand({ Bucket: bucketName(), Key: key }),
  );
  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) throw new Error(`R2 object has no body: ${key}`);
  return Buffer.from(bytes);
}

// Writes a brand-new asset and returns its storageKey. Filename generation
// (UUID + ext) lives here so every call site converges on one policy.
export async function putAsset(
  buffer: Buffer,
  ext: string,
  mimeType: string,
): Promise<{ storageKey: string; filename: string }> {
  const filename = `${randomUUID()}.${ext}`;
  if (isIntegrationConfigured("R2")) {
    await putR2(filename, buffer, mimeType);
    return { storageKey: `${R2_SCHEME}${filename}`, filename };
  }
  // Loud on purpose, not just the one-time boot log (instrumentation.ts):
  // this repo's dev DB is the same live database production reads from
  // (see memory: shared-remote-db), so a creative generated from a local
  // `npm run dev` with no R2 creds in the local .env writes its bytes to
  // THIS machine's disk while the row lands in the shared DB — production
  // then 404s on it, discovered days later instead of in this terminal now.
  console.warn(
    `[asset-storage] R2 not configured — writing ${filename} to local disk (${LOCAL_ASSETS_DIR}). If this DB is shared with production, that row will 404 there.`,
  );
  await writeLocal(filename, buffer);
  return { storageKey: `${LOCAL_ASSET_SCHEME}${filename}`, filename };
}

// Overwrites the file an EXISTING storageKey already points to (same
// key/filename, new content) — used by creative-template.ts's brand-logo
// compositing step, which edits an already-generated image in place.
export async function overwriteAsset(
  storageKey: string,
  buffer: Buffer,
  mimeType: string,
): Promise<void> {
  if (storageKey.startsWith(R2_SCHEME)) {
    const key = storageKey.slice(R2_SCHEME.length);
    assertSafeKey(key);
    await putR2(key, buffer, mimeType);
    return;
  }
  if (storageKey.startsWith(LOCAL_ASSET_SCHEME)) {
    const key = storageKey.slice(LOCAL_ASSET_SCHEME.length);
    assertSafeKey(key);
    await writeLocal(key, buffer);
    return;
  }
  throw new Error(`Unrecognized storageKey scheme: ${storageKey}`);
}

export async function readAsset(storageKey: string): Promise<Buffer> {
  if (storageKey.startsWith(R2_SCHEME)) {
    const key = storageKey.slice(R2_SCHEME.length);
    assertSafeKey(key);
    return getR2(key);
  }
  if (storageKey.startsWith(LOCAL_ASSET_SCHEME)) {
    const key = storageKey.slice(LOCAL_ASSET_SCHEME.length);
    assertSafeKey(key);
    return readLocal(key);
  }
  throw new Error(`Unrecognized storageKey scheme: ${storageKey}`);
}

// Best-effort — returns whether the backing object is now gone (true for a
// successful delete OR one that was already gone, since both S3-style
// DeleteObject and `rm --force` treat a missing key as success; false for
// an unrecognized scheme, an unsafe key, or a real backend error).
export async function deleteAsset(storageKey: string): Promise<boolean> {
  try {
    if (storageKey.startsWith(R2_SCHEME)) {
      const key = storageKey.slice(R2_SCHEME.length);
      assertSafeKey(key);
      await getR2Client().send(
        new DeleteObjectCommand({
          Bucket: bucketName(),
          Key: key,
        }),
      );
      return true;
    }
    if (storageKey.startsWith(LOCAL_ASSET_SCHEME)) {
      const key = storageKey.slice(LOCAL_ASSET_SCHEME.length);
      assertSafeKey(key);
      await rm(path.join(LOCAL_ASSETS_DIR, key), { force: true });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Non-null only for R2 — a permanent, unauthenticated URL external providers
// (Meta/TikTok/LinkedIn/X) can fetch directly. local-asset:// has no public
// URL of its own; callers fall back to the signed-token proxy
// (asset-public-link.ts) in that case.
export function resolveDirectPublicUrl(storageKey: string): string | null {
  if (!storageKey.startsWith(R2_SCHEME)) return null;
  const key = storageKey.slice(R2_SCHEME.length);
  return `${getEnv().R2_PUBLIC_URL}/${key}`;
}
