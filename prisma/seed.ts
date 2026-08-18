import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const BROWSER_PURPOSES = [
  { purpose: "PUBLIC_RESEARCH" as const, suffix: "research" },
  { purpose: "INSTAGRAM" as const, suffix: "instagram" },
  { purpose: "TIKTOK" as const, suffix: "tiktok" },
  { purpose: "META_ADS" as const, suffix: "meta" },
  { purpose: "GOOGLE_ADS" as const, suffix: "google" },
  { purpose: "LINKEDIN" as const, suffix: "linkedin" },
];

async function seedProject(
  workspaceId: string,
  name: string,
  slug: string,
  domain: string,
) {
  const project = await prisma.project.create({
    data: { workspaceId, name, slug, domain, status: "ACTIVE" },
  });

  const brand = await prisma.brand.create({
    data: {
      workspaceId,
      projectId: project.id,
      name,
      slug: "default",
      isDefault: true,
    },
  });

  await prisma.brandDossier.create({
    data: {
      workspaceId,
      projectId: project.id,
      brandId: brand.id,
      summary: `[SEED DEMO] ${name} is a demo brand seeded for Agentelse development.`,
      positioning: `[SEED DEMO] ${name} positioning statement placeholder.`,
      toneOfVoice: "Confident, modern, concise.",
      approvedColors: ["#111111", "#F5F5F5"],
      targetAudiences: [
        { label: "Primary", description: "18-34 urban professionals" },
      ],
      products: [
        {
          name: `${name} core product`,
          description: "Seed placeholder product.",
        },
      ],
    },
  });

  await prisma.negativeBriefRule.create({
    data: {
      workspaceId,
      projectId: project.id,
      brandId: brand.id,
      rule: "Never mention exact pricing in organic social captions.",
      category: "pricing",
    },
  });

  for (const { purpose, suffix } of BROWSER_PURPOSES) {
    await prisma.browserProfile.create({
      data: {
        workspaceId,
        projectId: project.id,
        brandId: brand.id,
        name: `${slug}-${suffix}`,
        slug: `${slug}-${suffix}`,
        purpose,
        status: "READY",
      },
    });
  }

  return { project, brand };
}

async function main() {
  const passwordHash = await bcrypt.hash("agentelse-dev", 10);

  const workspace = await prisma.workspace.create({
    data: { name: "Agentelse", slug: "agentelse" },
  });

  const user = await prisma.user.create({
    data: {
      name: "Agentelse Admin",
      email: "admin@agentelse.dev",
      passwordHash,
    },
  });

  await prisma.workspaceMember.create({
    data: { workspaceId: workspace.id, userId: user.id, role: "OWNER" },
  });

  const biduniq = await seedProject(
    workspace.id,
    "Biduniq",
    "biduniq",
    "biduniq.com",
  );
  const bitypay = await seedProject(
    workspace.id,
    "BityPay",
    "bitypay",
    "bitypay.com",
  );
  const blabla = await seedProject(
    workspace.id,
    "Blabla",
    "blabla",
    "blabla.com",
  );

  // A sample creative in review, so the Creative Studio / Approval Center
  // have something to render on first load.
  const creative = await prisma.creative.create({
    data: {
      workspaceId: workspace.id,
      projectId: biduniq.project.id,
      brandId: biduniq.brand.id,
      type: "SOCIAL_POST",
      platform: "INSTAGRAM",
      title: "[SEED DEMO] iPhone 17 launch post",
      brief: "iPhone 17-themed Instagram post",
      status: "IN_REVIEW",
    },
  });

  const version = await prisma.creativeVersion.create({
    data: {
      creativeId: creative.id,
      version: 1,
      caption: "[SEED DEMO] iPhone 17 is here. Discover it at Biduniq.",
      copy: "[SEED DEMO] placeholder copy",
      generationProvider: "seed",
    },
  });

  await prisma.creative.update({
    where: { id: creative.id },
    data: { currentVersionId: version.id },
  });

  await prisma.approval.create({
    data: {
      workspaceId: workspace.id,
      projectId: biduniq.project.id,
      brandId: biduniq.brand.id,
      entityType: "Creative",
      entityId: creative.id,
      type: "CREATIVE_APPROVAL",
      requestedByType: "AI",
      status: "PENDING",
    },
  });

  // A pending human intervention on Blabla's TikTok profile, so the Human
  // Action Center has a demo row (mirrors spec section 75/77).
  const blablaTiktokProfile = await prisma.browserProfile.findFirstOrThrow({
    where: { projectId: blabla.project.id, purpose: "TIKTOK" },
  });

  await prisma.humanInterventionRequest.create({
    data: {
      workspaceId: workspace.id,
      projectId: blabla.project.id,
      brandId: blabla.brand.id,
      browserProfileId: blablaTiktokProfile.id,
      type: "OTP_REQUIRED",
      inputType: "OTP",
      status: "PENDING",
      title: "[SEED DEMO] TikTok account setup needs SMS code",
      message: "TikTok sent a verification code to continue account creation.",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });

  // Agency OS baseline for demo projects: autonomy policy + default
  // department modes so the continuous loop has a governed starting posture.
  for (const seeded of [biduniq, bitypay, blabla]) {
    await prisma.autonomyPolicy.upsert({
      where: { projectId: seeded.project.id },
      create: {
        workspaceId: workspace.id,
        projectId: seeded.project.id,
        brandId: seeded.brand.id,
        setupAutoApprove: false,
      },
      update: {},
    });
    for (const department of [
      "BRAND_STRATEGY",
      "MARKET_INTELLIGENCE",
      "COMPETITOR_INTELLIGENCE",
      "CREATIVE",
      "COPY_CONTENT",
      "SOCIAL_MEDIA",
      "SEO",
      "DATA_ANALYTICS",
    ] as const) {
      await prisma.projectDepartment.upsert({
        where: {
          projectId_department: {
            projectId: seeded.project.id,
            department,
          },
        },
        create: {
          workspaceId: workspace.id,
          projectId: seeded.project.id,
          brandId: seeded.brand.id,
          department,
          mode:
            department.endsWith("INTELLIGENCE") ||
            department === "DATA_ANALYTICS" ||
            department === "BRAND_STRATEGY"
              ? "EXECUTE"
              : "PREPARE",
        },
        update: {},
      });
    }
  }

  console.log("Seed complete:");
  console.log(`  Workspace: ${workspace.name} (${workspace.id})`);
  console.log(`  Admin login: admin@agentelse.dev / agentelse-dev`);
  console.log(
    `  Projects: Biduniq (${biduniq.project.id}), BityPay (${bitypay.project.id}), Blabla (${blabla.project.id})`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
