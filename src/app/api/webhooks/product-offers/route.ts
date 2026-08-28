import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { SignalUniverse } from "@/server/agency/signals/signal-universe";
import { decryptSecret } from "@/server/security/crypto";

// Generic inbound webhook: an external system (an e-commerce/auction
// backend, e.g.) reports that one of a project's products has entered or
// left a dynamic offer/bid window. Deliberately generic — no biduniq-
// specific fields — connecting a real external system to this endpoint
// (adding the actual outbound call on that system's side) is a separate,
// out-of-repo integration step.
//
// Auth mirrors the existing IntegrationCredential pattern (see meta-client.ts
// / google-client.ts) instead of a single global secret like /api/cron/worker:
// each project that wants to send events here gets its own
// IntegrationCredential row (provider: "product-offer-webhook",
// encryptedSecret: a generated per-project token) so one leaked token only
// exposes one project's webhook, not every project's.
const PRODUCT_OFFER_WEBHOOK_PROVIDER = "product-offer-webhook";

const PayloadSchema = z.object({
  projectId: z.string().min(1),
  token: z.string().min(1),
  externalId: z.string().min(1),
  name: z.string().min(1),
  minPrice: z.number().optional(),
  maxPrice: z.number().optional(),
  status: z.enum(["SCHEDULED", "ACTIVE", "COMPLETED", "CANCELLED"]),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
});

function isValidToken(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return (
    providedBuf.length === expectedBuf.length &&
    timingSafeEqual(providedBuf, expectedBuf)
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = PayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const credential = await prisma.integrationCredential.findUnique({
    where: {
      projectId_provider: {
        projectId: input.projectId,
        provider: PRODUCT_OFFER_WEBHOOK_PROVIDER,
      },
    },
  });
  if (!credential || credential.status !== "ACTIVE") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isValidToken(input.token, decryptSecret(credential.encryptedSecret))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const product = await prisma.product.upsert({
    where: {
      projectId_externalId: {
        projectId: input.projectId,
        externalId: input.externalId,
      },
    },
    update: { name: input.name },
    create: {
      workspaceId: credential.workspaceId,
      projectId: input.projectId,
      brandId: credential.brandId,
      externalId: input.externalId,
      name: input.name,
    },
  });

  const existingOffer = await prisma.productOffer.findUnique({
    where: {
      productId_externalRef: {
        productId: product.id,
        externalRef: input.externalId,
      },
    },
  });

  const offerData = {
    minPrice: input.minPrice,
    maxPrice: input.maxPrice,
    status: input.status,
    startsAt: input.startsAt ? new Date(input.startsAt) : undefined,
    endsAt: input.endsAt ? new Date(input.endsAt) : undefined,
  };
  const offer = await prisma.productOffer.upsert({
    where: {
      productId_externalRef: {
        productId: product.id,
        externalRef: input.externalId,
      },
    },
    update: offerData,
    create: {
      productId: product.id,
      externalRef: input.externalId,
      ...offerData,
    },
  });

  // Only ingest a signal on a genuine transition INTO ACTIVE — not every
  // update (e.g. a price tweak on an already-active offer) should spawn a
  // fresh "announce this" idea in the funnel every time.
  if (input.status === "ACTIVE" && existingOffer?.status !== "ACTIVE") {
    await SignalUniverse.ingestRaw({
      workspaceId: credential.workspaceId,
      projectId: input.projectId,
      brandId: credential.brandId,
      source: "external-product-offer-webhook",
      category: "PRODUCT_LAUNCH",
      externalRef: `product-offer:${offer.id}:${offer.updatedAt.toISOString()}`,
      title: `${input.name}: teklif penceresi açıldı`,
      summary:
        `"${input.name}" için dinamik teklif penceresi aktif oldu` +
        (input.minPrice !== undefined && input.maxPrice !== undefined
          ? ` (${input.minPrice}-${input.maxPrice} aralığında).`
          : "."),
      payload: { productId: product.id, offerId: offer.id },
      reliability: 1,
    });
  }

  return NextResponse.json({
    ok: true,
    productId: product.id,
    offerId: offer.id,
  });
}
