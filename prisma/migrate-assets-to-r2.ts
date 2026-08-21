import path from "node:path";
import { readFile } from "node:fs/promises";

import { PrismaClient } from "@prisma/client";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// Backfills every Asset still on local-asset:// storage to R2. Run once per
// machine that has been generating assets (local dev AND, before its next
// deploy overwrites the container's disk, production) after R2 credentials
// are added to that machine's env — a shared DB + per-machine local disk
// (see src/server/storage/asset-storage.ts) means these rows only load from
// the machine that created them until they're promoted here.
//
// Self-contained on purpose, like the other prisma/*.ts scripts: importing
// src/server/storage/asset-storage.ts here would pull in its `server-only`
// guard, which throws outside Next's own build/server-component context.

const prisma = new PrismaClient();
const LOCAL_ASSETS_DIR = path.join(process.cwd(), "storage", "assets");

function requireR2Env() {
  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
  } = process.env;
  if (
    !R2_ACCOUNT_ID ||
    !R2_ACCESS_KEY_ID ||
    !R2_SECRET_ACCESS_KEY ||
    !R2_BUCKET_NAME
  ) {
    console.error(
      "R2 is not configured in this environment (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/" +
        "R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME) — add those env vars first.",
    );
    process.exit(1);
  }
  return {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const env = dryRun ? null : requireR2Env();
  const s3 = env
    ? new S3Client({
        region: "auto",
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
      })
    : null;

  const assets = await prisma.asset.findMany({
    where: { storageKey: { startsWith: "local-asset://" } },
    select: { id: true, storageKey: true, mimeType: true, filename: true },
  });

  console.log(
    `${assets.length} asset row(s) still on local-asset:// storage.${dryRun ? " (dry run — no uploads, no DB writes)" : ""}\n`,
  );

  let migrated = 0;
  let missingLocally = 0;
  let failed = 0;

  for (const asset of assets) {
    const filename = asset.storageKey.replace("local-asset://", "");

    if (dryRun) {
      console.log(`would migrate: ${asset.id} (${filename})`);
      continue;
    }

    try {
      const buffer = await readFile(path.join(LOCAL_ASSETS_DIR, filename));
      await s3!.send(
        new PutObjectCommand({
          Bucket: env!.R2_BUCKET_NAME,
          Key: filename,
          Body: buffer,
          ContentType: asset.mimeType,
        }),
      );
      await prisma.asset.update({
        where: { id: asset.id },
        data: { storageKey: `r2://${filename}` },
      });
      migrated += 1;
      console.log(`migrated: ${asset.id} -> r2://${filename}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ENOENT")) {
        missingLocally += 1;
        console.log(
          `skipped (file not on this machine): ${asset.id} (${filename})`,
        );
      } else {
        failed += 1;
        console.error(`failed: ${asset.id} (${filename}) — ${message}`);
      }
    }
  }

  console.log(
    `\nDone. migrated=${migrated} missingLocally=${missingLocally} failed=${failed}`,
  );
  if (missingLocally > 0) {
    console.log(
      "Assets 'missing locally' were created on a different machine (e.g. " +
        "production). Run this same script from that machine — before its " +
        "next deploy/restart wipes its local disk — to recover them.",
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
