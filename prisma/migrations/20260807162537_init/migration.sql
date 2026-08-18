-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('CREATED', 'DISCOVERY', 'NEEDS_INFORMATION', 'PROFILE_REVIEW', 'NEEDS_ASSESSMENT', 'STRATEGY', 'ACTIVE', 'PAUSED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'AI', 'OPENCLAW', 'API', 'TELEGRAM', 'PARTNER');

-- CreateEnum
CREATE TYPE "CommandSource" AS ENUM ('WEB', 'TELEGRAM', 'API', 'SYSTEM', 'SCHEDULE');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('DRAFT', 'READY', 'QUEUED', 'RUNNING', 'WAITING_INPUT', 'WAITING_HUMAN', 'WAITING_APPROVAL', 'WAITING_PROVIDER', 'VERIFYING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OperationPhase" AS ENUM ('OBSERVE', 'THINK', 'PROPOSE', 'APPROVE', 'ACT', 'VERIFY', 'LEARN');

-- CreateEnum
CREATE TYPE "ExecutionProviderType" AS ENUM ('OPENCLAW', 'AI', 'API', 'HUMAN', 'EXTERNAL_PARTNER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ExecutionJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_HUMAN', 'WAITING_PROVIDER', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CapabilityKey" AS ENUM ('BRAND_DISCOVERY', 'WEB_RESEARCH', 'WEB_BROWSING', 'DATA_EXTRACTION', 'SCREENSHOT_CAPTURE', 'COMPETITOR_RESEARCH', 'COMPETITOR_MONITORING', 'COMPETITOR_CHANGE_DETECTION', 'MARKET_RESEARCH', 'TREND_RESEARCH', 'CUSTOMER_INTELLIGENCE', 'SEO_RESEARCH', 'SEO_ANALYSIS', 'ASO_ANALYSIS', 'SOCIAL_RESEARCH', 'SOCIAL_ACCOUNT_SETUP', 'SOCIAL_PROFILE_AUDIT', 'CREATE_SOCIAL_CREATIVE', 'CREATE_AD_CREATIVE', 'CREATE_COPY', 'CREATE_CAPTION', 'CREATE_CAMPAIGN_BRIEF', 'CREATE_CONTENT_PLAN', 'INSTAGRAM_PUBLISH', 'TIKTOK_PUBLISH', 'LINKEDIN_PUBLISH', 'X_PUBLISH', 'META_ADS_ANALYSIS', 'META_CAMPAIGN_CREATE', 'META_CAMPAIGN_UPDATE', 'GOOGLE_ADS_ANALYSIS', 'GOOGLE_ADS_CAMPAIGN_CREATE', 'ANALYTICS_ANALYSIS', 'CRM_ANALYSIS', 'EMAIL_DRAFT', 'EMAIL_SEND', 'CLAIM_VALIDATION', 'BRAND_SAFETY', 'REPORTING', 'VERIFY_EXTERNAL_ACTION');

-- CreateEnum
CREATE TYPE "BrowserProfilePurpose" AS ENUM ('PUBLIC_RESEARCH', 'INSTAGRAM', 'TIKTOK', 'META_ADS', 'GOOGLE_ADS', 'GA4', 'SEARCH_CONSOLE', 'LINKEDIN', 'X', 'CRM', 'EMAIL', 'GENERAL');

-- CreateEnum
CREATE TYPE "BrowserProfileStatus" AS ENUM ('READY', 'RUNNING', 'WAITING', 'LOGIN_REQUIRED', 'MFA_REQUIRED', 'OTP_REQUIRED', 'CAPTCHA_REQUIRED', 'SESSION_EXPIRED', 'USER_ACTION_REQUIRED', 'PERMISSION_REQUIRED', 'UNHEALTHY', 'DISABLED');

-- CreateEnum
CREATE TYPE "HumanInterventionType" AS ENUM ('OTP_REQUIRED', 'MFA_REQUIRED', 'LOGIN_REQUIRED', 'CAPTCHA_REQUIRED', 'CONFIRMATION_REQUIRED', 'MANUAL_BROWSER_REQUIRED', 'ACCOUNT_SELECTION_REQUIRED', 'FILE_REQUIRED', 'INFORMATION_REQUIRED', 'DECISION_REQUIRED');

-- CreateEnum
CREATE TYPE "HumanInterventionStatus" AS ENUM ('PENDING', 'RESOLVED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "HumanInterventionInputType" AS ENUM ('TEXT', 'OTP', 'CONFIRM', 'CHOICE', 'MANUAL_BROWSER', 'FILE');

-- CreateEnum
CREATE TYPE "ApprovalType" AS ENUM ('CREATIVE_APPROVAL', 'PUBLISH_APPROVAL', 'CAMPAIGN_APPROVAL', 'ACCOUNT_ACTION_APPROVAL', 'CRITICAL_CHANGE_APPROVAL', 'GENERIC');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CreativeType" AS ENUM ('SOCIAL_POST', 'AD_CREATIVE', 'CAPTION', 'COPY', 'CAMPAIGN_BRIEF', 'CONTENT_PLAN');

-- CreateEnum
CREATE TYPE "CreativeStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('INSTAGRAM', 'TIKTOK', 'LINKEDIN', 'X', 'FACEBOOK', 'YOUTUBE', 'PINTEREST');

-- CreateEnum
CREATE TYPE "SocialAccountStatus" AS ENUM ('CONNECTING', 'CONNECTED', 'LOGIN_REQUIRED', 'SUSPENDED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "EvidenceSourceType" AS ENUM ('WEB_PAGE', 'SCREENSHOT', 'API', 'DOCUMENT', 'SOCIAL_MEDIA', 'AD_LIBRARY', 'SEARCH_RESULT', 'USER_INPUT', 'INTERNAL_DATA', 'SYSTEM_VERIFICATION');

-- CreateEnum
CREATE TYPE "ExecutionVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "SkillStatus" AS ENUM ('DISCOVERED', 'REVIEW_PENDING', 'APPROVED', 'ACTIVE', 'DISABLED', 'DEPRECATED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "SkillSecurityStatus" AS ENUM ('UNKNOWN', 'PASS', 'REVIEW_REQUIRED', 'SUSPICIOUS', 'BLOCKED');

-- CreateEnum
CREATE TYPE "SkillTrustLevel" AS ENUM ('UNTRUSTED', 'COMMUNITY', 'REVIEWED', 'TRUSTED', 'INTERNAL');

-- CreateEnum
CREATE TYPE "SkillPermissionType" AS ENUM ('BROWSER', 'NETWORK', 'FILE_READ', 'FILE_WRITE', 'CREDENTIAL', 'CLIPBOARD', 'SHELL', 'EXTERNAL_API', 'USER_DATA');

-- CreateEnum
CREATE TYPE "ProviderHealthStatus" AS ENUM ('AVAILABLE', 'DEGRADED', 'RATE_LIMITED', 'AUTH_REQUIRED', 'UNAVAILABLE', 'DISABLED');

-- CreateEnum
CREATE TYPE "DataClassification" AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'SENSITIVE', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('IMAGE', 'VIDEO', 'DOCUMENT', 'SCREENSHOT', 'LOGO', 'CREATIVE', 'REPORT');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'NOT_CONFIGURED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('NEW', 'REVIEWING', 'ACCEPTED', 'DISMISSED', 'CONVERTED_TO_TASK');

-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('CRON', 'INTERVAL', 'ONE_OFF');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "domain" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'CREATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandDossier" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "summary" TEXT,
    "positioning" TEXT,
    "targetAudiences" JSONB,
    "markets" JSONB,
    "products" JSONB,
    "services" JSONB,
    "toneOfVoice" TEXT,
    "visualGuidelines" JSONB,
    "approvedColors" JSONB,
    "approvedFonts" JSONB,
    "logoAssetId" TEXT,
    "currentStrategyVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandDossier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandFact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "source" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandAssumption" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandAssumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovedClaim" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovedClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NegativeBriefRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NegativeBriefRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandDecision" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "rationale" TEXT,
    "decidedByType" "ActorType" NOT NULL,
    "decidedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandLearning" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "insight" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceRef" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandLearning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandStrategyVersion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "summary" TEXT,
    "payload" JSONB NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandStrategyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandEvidence" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "relatedEntityType" TEXT NOT NULL,
    "relatedEntityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionContextSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandBrainVersion" INTEGER,
    "strategyVersion" INTEGER,
    "negativeBriefVersion" INTEGER,
    "payload" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionContextSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Command" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "brandId" TEXT,
    "source" "CommandSource" NOT NULL,
    "rawText" TEXT NOT NULL,
    "parsedIntent" JSONB,
    "createdByUserId" TEXT,
    "telegramConversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Command_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "commandId" TEXT,
    "parentTaskId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "capability" "CapabilityKey" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "createdByType" "ActorType" NOT NULL,
    "createdByUserId" TEXT,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "requiresVerification" BOOLEAN NOT NULL DEFAULT false,
    "dueAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskDependency" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "dependsOnTaskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "capability" "CapabilityKey" NOT NULL,
    "providerType" "ExecutionProviderType" NOT NULL,
    "providerId" TEXT,
    "skillId" TEXT,
    "skillVersion" TEXT,
    "browserProfileId" TEXT,
    "phase" "OperationPhase" NOT NULL DEFAULT 'ACT',
    "status" "ExecutionJobStatus" NOT NULL DEFAULT 'QUEUED',
    "correlationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "contextSnapshotId" TEXT,
    "requestPayload" JSONB,
    "rawResult" JSONB,
    "normalizedResult" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "estimatedCost" DOUBLE PRECISION,
    "actualCost" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExecutionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderDefinition" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerType" "ExecutionProviderType" NOT NULL,
    "configured" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderHealth" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "status" "ProviderHealthStatus" NOT NULL DEFAULT 'UNAVAILABLE',
    "lastCheckAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderIncident" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ProviderIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanInterventionRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "taskId" TEXT,
    "executionJobId" TEXT,
    "browserProfileId" TEXT,
    "type" "HumanInterventionType" NOT NULL,
    "status" "HumanInterventionStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "message" TEXT,
    "inputType" "HumanInterventionInputType" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HumanInterventionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemporarySecret" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "humanInterventionRequestId" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemporarySecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "taskId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "type" "ApprovalType" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedByType" "ActorType" NOT NULL,
    "requestedById" TEXT,
    "reviewedByUserId" TEXT,
    "reviewNote" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "type" "AssetType" NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "hash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Creative" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "type" "CreativeType" NOT NULL,
    "platform" "SocialPlatform",
    "title" TEXT,
    "brief" TEXT,
    "status" "CreativeStatus" NOT NULL DEFAULT 'DRAFT',
    "currentVersionId" TEXT,
    "createdByTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Creative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativeVersion" (
    "id" TEXT NOT NULL,
    "creativeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "assetId" TEXT,
    "caption" TEXT,
    "copy" TEXT,
    "generationProvider" TEXT,
    "generationMetadata" JSONB,
    "revisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "executionJobId" TEXT,
    "sourceType" "EvidenceSourceType" NOT NULL,
    "sourceUrl" TEXT,
    "pageTitle" TEXT,
    "assetId" TEXT,
    "statement" TEXT,
    "extractedText" TEXT,
    "confidenceScore" DOUBLE PRECISION,
    "accessedAt" TIMESTAMP(3),
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutionVerification" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "executionJobId" TEXT NOT NULL,
    "status" "ExecutionVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "expectedState" JSONB,
    "observedState" JSONB,
    "evidenceIds" TEXT[],
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutionVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Competitor" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorSource" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorSnapshot" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorChange" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "fromSnapshotId" TEXT,
    "toSnapshotId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "diff" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorInsight" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "changeId" TEXT,
    "insight" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "insightId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgencyIdea" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "suggestedCapability" "CapabilityKey",
    "convertedToTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgencyIdea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrowserProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openclaw',
    "purpose" "BrowserProfilePurpose" NOT NULL,
    "status" "BrowserProfileStatus" NOT NULL DEFAULT 'READY',
    "externalProfileId" TEXT,
    "sessionReference" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "lastHealthCheckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrowserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT,
    "profileUrl" TEXT,
    "browserProfileId" TEXT,
    "credentialId" TEXT,
    "status" "SocialAccountStatus" NOT NULL DEFAULT 'CONNECTING',
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationCredential" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "accountLabel" TEXT,
    "secretReference" TEXT NOT NULL,
    "status" "CredentialStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "providerType" "ExecutionProviderType" NOT NULL,
    "externalSkillId" TEXT,
    "source" TEXT NOT NULL,
    "publisher" TEXT,
    "description" TEXT,
    "status" "SkillStatus" NOT NULL DEFAULT 'DISCOVERED',
    "securityStatus" "SkillSecurityStatus" NOT NULL DEFAULT 'UNKNOWN',
    "trustLevel" "SkillTrustLevel" NOT NULL DEFAULT 'UNTRUSTED',
    "currentVersion" TEXT,
    "capabilities" "CapabilityKey"[],
    "requiredPermissions" "SkillPermissionType"[],
    "requiredIntegrations" TEXT[],
    "inputSchema" JSONB,
    "outputSchema" JSONB,
    "configSchema" JSONB,
    "installedAt" TIMESTAMP(3),
    "lastReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSkill" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "configuration" JSONB,
    "allowedCapabilities" "CapabilityKey"[],
    "allowedRiskLevels" "RiskLevel"[],
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "executionJobId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeadLetterJob" (
    "id" TEXT NOT NULL,
    "executionJobId" TEXT,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "DeadLetterJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectSchedule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capability" "CapabilityKey" NOT NULL,
    "scheduleType" "ScheduleType" NOT NULL,
    "cronExpression" TEXT,
    "configuration" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "botUsername" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramUserBinding" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pairingCode" TEXT,
    "pairingExpiresAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramUserBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramConversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "brandId" TEXT,
    "bindingId" TEXT NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "text" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramAction" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "brandId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "Project_workspaceId_idx" ON "Project"("workspaceId");

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Project_workspaceId_slug_key" ON "Project"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "Brand_workspaceId_idx" ON "Brand"("workspaceId");

-- CreateIndex
CREATE INDEX "Brand_projectId_idx" ON "Brand"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_projectId_slug_key" ON "Brand"("projectId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "BrandDossier_brandId_key" ON "BrandDossier"("brandId");

-- CreateIndex
CREATE INDEX "BrandDossier_workspaceId_idx" ON "BrandDossier"("workspaceId");

-- CreateIndex
CREATE INDEX "BrandDossier_projectId_idx" ON "BrandDossier"("projectId");

-- CreateIndex
CREATE INDEX "BrandFact_workspaceId_idx" ON "BrandFact"("workspaceId");

-- CreateIndex
CREATE INDEX "BrandFact_projectId_idx" ON "BrandFact"("projectId");

-- CreateIndex
CREATE INDEX "BrandFact_brandId_idx" ON "BrandFact"("brandId");

-- CreateIndex
CREATE INDEX "BrandFact_brandId_category_idx" ON "BrandFact"("brandId", "category");

-- CreateIndex
CREATE INDEX "BrandAssumption_projectId_idx" ON "BrandAssumption"("projectId");

-- CreateIndex
CREATE INDEX "BrandAssumption_brandId_idx" ON "BrandAssumption"("brandId");

-- CreateIndex
CREATE INDEX "ApprovedClaim_projectId_idx" ON "ApprovedClaim"("projectId");

-- CreateIndex
CREATE INDEX "ApprovedClaim_brandId_idx" ON "ApprovedClaim"("brandId");

-- CreateIndex
CREATE INDEX "NegativeBriefRule_projectId_idx" ON "NegativeBriefRule"("projectId");

-- CreateIndex
CREATE INDEX "NegativeBriefRule_brandId_idx" ON "NegativeBriefRule"("brandId");

-- CreateIndex
CREATE INDEX "BrandDecision_projectId_idx" ON "BrandDecision"("projectId");

-- CreateIndex
CREATE INDEX "BrandDecision_brandId_idx" ON "BrandDecision"("brandId");

-- CreateIndex
CREATE INDEX "BrandLearning_projectId_idx" ON "BrandLearning"("projectId");

-- CreateIndex
CREATE INDEX "BrandLearning_brandId_idx" ON "BrandLearning"("brandId");

-- CreateIndex
CREATE INDEX "BrandStrategyVersion_projectId_idx" ON "BrandStrategyVersion"("projectId");

-- CreateIndex
CREATE INDEX "BrandStrategyVersion_brandId_idx" ON "BrandStrategyVersion"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandStrategyVersion_brandId_version_key" ON "BrandStrategyVersion"("brandId", "version");

-- CreateIndex
CREATE INDEX "BrandEvidence_projectId_idx" ON "BrandEvidence"("projectId");

-- CreateIndex
CREATE INDEX "BrandEvidence_brandId_idx" ON "BrandEvidence"("brandId");

-- CreateIndex
CREATE INDEX "BrandEvidence_relatedEntityType_relatedEntityId_idx" ON "BrandEvidence"("relatedEntityType", "relatedEntityId");

-- CreateIndex
CREATE INDEX "ExecutionContextSnapshot_workspaceId_idx" ON "ExecutionContextSnapshot"("workspaceId");

-- CreateIndex
CREATE INDEX "ExecutionContextSnapshot_projectId_idx" ON "ExecutionContextSnapshot"("projectId");

-- CreateIndex
CREATE INDEX "ExecutionContextSnapshot_brandId_idx" ON "ExecutionContextSnapshot"("brandId");

-- CreateIndex
CREATE INDEX "Command_workspaceId_idx" ON "Command"("workspaceId");

-- CreateIndex
CREATE INDEX "Command_projectId_idx" ON "Command"("projectId");

-- CreateIndex
CREATE INDEX "Command_createdAt_idx" ON "Command"("createdAt");

-- CreateIndex
CREATE INDEX "Task_workspaceId_idx" ON "Task"("workspaceId");

-- CreateIndex
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");

-- CreateIndex
CREATE INDEX "Task_brandId_idx" ON "Task"("brandId");

-- CreateIndex
CREATE INDEX "Task_status_idx" ON "Task"("status");

-- CreateIndex
CREATE INDEX "Task_capability_idx" ON "Task"("capability");

-- CreateIndex
CREATE INDEX "Task_createdAt_idx" ON "Task"("createdAt");

-- CreateIndex
CREATE INDEX "Task_projectId_status_idx" ON "Task"("projectId", "status");

-- CreateIndex
CREATE INDEX "TaskDependency_dependsOnTaskId_idx" ON "TaskDependency"("dependsOnTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskDependency_taskId_dependsOnTaskId_key" ON "TaskDependency"("taskId", "dependsOnTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionJob_correlationId_key" ON "ExecutionJob"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionJob_idempotencyKey_key" ON "ExecutionJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ExecutionJob_workspaceId_idx" ON "ExecutionJob"("workspaceId");

-- CreateIndex
CREATE INDEX "ExecutionJob_projectId_idx" ON "ExecutionJob"("projectId");

-- CreateIndex
CREATE INDEX "ExecutionJob_brandId_idx" ON "ExecutionJob"("brandId");

-- CreateIndex
CREATE INDEX "ExecutionJob_status_idx" ON "ExecutionJob"("status");

-- CreateIndex
CREATE INDEX "ExecutionJob_capability_idx" ON "ExecutionJob"("capability");

-- CreateIndex
CREATE INDEX "ExecutionJob_createdAt_idx" ON "ExecutionJob"("createdAt");

-- CreateIndex
CREATE INDEX "ExecutionJob_taskId_idx" ON "ExecutionJob"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderDefinition_key_key" ON "ProviderDefinition"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderHealth_providerId_key" ON "ProviderHealth"("providerId");

-- CreateIndex
CREATE INDEX "ProviderIncident_providerId_idx" ON "ProviderIncident"("providerId");

-- CreateIndex
CREATE INDEX "HumanInterventionRequest_workspaceId_idx" ON "HumanInterventionRequest"("workspaceId");

-- CreateIndex
CREATE INDEX "HumanInterventionRequest_projectId_idx" ON "HumanInterventionRequest"("projectId");

-- CreateIndex
CREATE INDEX "HumanInterventionRequest_brandId_idx" ON "HumanInterventionRequest"("brandId");

-- CreateIndex
CREATE INDEX "HumanInterventionRequest_status_idx" ON "HumanInterventionRequest"("status");

-- CreateIndex
CREATE INDEX "HumanInterventionRequest_createdAt_idx" ON "HumanInterventionRequest"("createdAt");

-- CreateIndex
CREATE INDEX "TemporarySecret_expiresAt_idx" ON "TemporarySecret"("expiresAt");

-- CreateIndex
CREATE INDEX "TemporarySecret_humanInterventionRequestId_idx" ON "TemporarySecret"("humanInterventionRequestId");

-- CreateIndex
CREATE INDEX "Approval_workspaceId_idx" ON "Approval"("workspaceId");

-- CreateIndex
CREATE INDEX "Approval_projectId_idx" ON "Approval"("projectId");

-- CreateIndex
CREATE INDEX "Approval_brandId_idx" ON "Approval"("brandId");

-- CreateIndex
CREATE INDEX "Approval_status_idx" ON "Approval"("status");

-- CreateIndex
CREATE INDEX "Approval_entityType_entityId_idx" ON "Approval"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Asset_workspaceId_idx" ON "Asset"("workspaceId");

-- CreateIndex
CREATE INDEX "Asset_projectId_idx" ON "Asset"("projectId");

-- CreateIndex
CREATE INDEX "Asset_brandId_idx" ON "Asset"("brandId");

-- CreateIndex
CREATE INDEX "Creative_workspaceId_idx" ON "Creative"("workspaceId");

-- CreateIndex
CREATE INDEX "Creative_projectId_idx" ON "Creative"("projectId");

-- CreateIndex
CREATE INDEX "Creative_brandId_idx" ON "Creative"("brandId");

-- CreateIndex
CREATE INDEX "Creative_status_idx" ON "Creative"("status");

-- CreateIndex
CREATE INDEX "CreativeVersion_creativeId_idx" ON "CreativeVersion"("creativeId");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeVersion_creativeId_version_key" ON "CreativeVersion"("creativeId", "version");

-- CreateIndex
CREATE INDEX "Evidence_workspaceId_idx" ON "Evidence"("workspaceId");

-- CreateIndex
CREATE INDEX "Evidence_projectId_idx" ON "Evidence"("projectId");

-- CreateIndex
CREATE INDEX "Evidence_brandId_idx" ON "Evidence"("brandId");

-- CreateIndex
CREATE INDEX "Evidence_executionJobId_idx" ON "Evidence"("executionJobId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionVerification_executionJobId_key" ON "ExecutionVerification"("executionJobId");

-- CreateIndex
CREATE INDEX "ExecutionVerification_projectId_idx" ON "ExecutionVerification"("projectId");

-- CreateIndex
CREATE INDEX "ExecutionVerification_status_idx" ON "ExecutionVerification"("status");

-- CreateIndex
CREATE INDEX "Competitor_projectId_idx" ON "Competitor"("projectId");

-- CreateIndex
CREATE INDEX "Competitor_brandId_idx" ON "Competitor"("brandId");

-- CreateIndex
CREATE INDEX "CompetitorSource_competitorId_idx" ON "CompetitorSource"("competitorId");

-- CreateIndex
CREATE INDEX "CompetitorSnapshot_competitorId_idx" ON "CompetitorSnapshot"("competitorId");

-- CreateIndex
CREATE INDEX "CompetitorSnapshot_capturedAt_idx" ON "CompetitorSnapshot"("capturedAt");

-- CreateIndex
CREATE INDEX "CompetitorChange_competitorId_idx" ON "CompetitorChange"("competitorId");

-- CreateIndex
CREATE INDEX "CompetitorInsight_competitorId_idx" ON "CompetitorInsight"("competitorId");

-- CreateIndex
CREATE INDEX "Opportunity_projectId_idx" ON "Opportunity"("projectId");

-- CreateIndex
CREATE INDEX "Opportunity_brandId_idx" ON "Opportunity"("brandId");

-- CreateIndex
CREATE INDEX "Opportunity_status_idx" ON "Opportunity"("status");

-- CreateIndex
CREATE INDEX "AgencyIdea_projectId_idx" ON "AgencyIdea"("projectId");

-- CreateIndex
CREATE INDEX "AgencyIdea_brandId_idx" ON "AgencyIdea"("brandId");

-- CreateIndex
CREATE INDEX "BrowserProfile_workspaceId_idx" ON "BrowserProfile"("workspaceId");

-- CreateIndex
CREATE INDEX "BrowserProfile_projectId_idx" ON "BrowserProfile"("projectId");

-- CreateIndex
CREATE INDEX "BrowserProfile_brandId_idx" ON "BrowserProfile"("brandId");

-- CreateIndex
CREATE INDEX "BrowserProfile_status_idx" ON "BrowserProfile"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BrowserProfile_projectId_slug_key" ON "BrowserProfile"("projectId", "slug");

-- CreateIndex
CREATE INDEX "SocialAccount_workspaceId_idx" ON "SocialAccount"("workspaceId");

-- CreateIndex
CREATE INDEX "SocialAccount_projectId_idx" ON "SocialAccount"("projectId");

-- CreateIndex
CREATE INDEX "SocialAccount_brandId_idx" ON "SocialAccount"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_projectId_platform_username_key" ON "SocialAccount"("projectId", "platform", "username");

-- CreateIndex
CREATE INDEX "IntegrationCredential_workspaceId_idx" ON "IntegrationCredential"("workspaceId");

-- CreateIndex
CREATE INDEX "IntegrationCredential_projectId_idx" ON "IntegrationCredential"("projectId");

-- CreateIndex
CREATE INDEX "IntegrationCredential_brandId_idx" ON "IntegrationCredential"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_slug_key" ON "Skill"("slug");

-- CreateIndex
CREATE INDEX "Skill_status_idx" ON "Skill"("status");

-- CreateIndex
CREATE INDEX "ProjectSkill_workspaceId_idx" ON "ProjectSkill"("workspaceId");

-- CreateIndex
CREATE INDEX "ProjectSkill_projectId_idx" ON "ProjectSkill"("projectId");

-- CreateIndex
CREATE INDEX "ProjectSkill_brandId_idx" ON "ProjectSkill"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSkill_projectId_skillId_key" ON "ProjectSkill"("projectId", "skillId");

-- CreateIndex
CREATE INDEX "OutboxEvent_workspaceId_idx" ON "OutboxEvent"("workspaceId");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_idx" ON "OutboxEvent"("status");

-- CreateIndex
CREATE INDEX "OutboxEvent_nextAttemptAt_idx" ON "OutboxEvent"("nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx" ON "OutboxEvent"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "DeadLetterJob_executionJobId_idx" ON "DeadLetterJob"("executionJobId");

-- CreateIndex
CREATE INDEX "DeadLetterJob_resolvedAt_idx" ON "DeadLetterJob"("resolvedAt");

-- CreateIndex
CREATE INDEX "ProjectSchedule_workspaceId_idx" ON "ProjectSchedule"("workspaceId");

-- CreateIndex
CREATE INDEX "ProjectSchedule_projectId_idx" ON "ProjectSchedule"("projectId");

-- CreateIndex
CREATE INDEX "ProjectSchedule_brandId_idx" ON "ProjectSchedule"("brandId");

-- CreateIndex
CREATE INDEX "ProjectSchedule_nextRunAt_idx" ON "ProjectSchedule"("nextRunAt");

-- CreateIndex
CREATE INDEX "ProjectSchedule_enabled_idx" ON "ProjectSchedule"("enabled");

-- CreateIndex
CREATE INDEX "TelegramConnection_workspaceId_idx" ON "TelegramConnection"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUserBinding_telegramUserId_key" ON "TelegramUserBinding"("telegramUserId");

-- CreateIndex
CREATE INDEX "TelegramUserBinding_workspaceId_idx" ON "TelegramUserBinding"("workspaceId");

-- CreateIndex
CREATE INDEX "TelegramUserBinding_userId_idx" ON "TelegramUserBinding"("userId");

-- CreateIndex
CREATE INDEX "TelegramConversation_workspaceId_idx" ON "TelegramConversation"("workspaceId");

-- CreateIndex
CREATE INDEX "TelegramConversation_bindingId_idx" ON "TelegramConversation"("bindingId");

-- CreateIndex
CREATE INDEX "TelegramMessage_conversationId_idx" ON "TelegramMessage"("conversationId");

-- CreateIndex
CREATE INDEX "TelegramAction_conversationId_idx" ON "TelegramAction"("conversationId");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_idx" ON "AuditLog"("workspaceId");

-- CreateIndex
CREATE INDEX "AuditLog_projectId_idx" ON "AuditLog"("projectId");

-- CreateIndex
CREATE INDEX "AuditLog_brandId_idx" ON "AuditLog"("brandId");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandEvidence" ADD CONSTRAINT "BrandEvidence_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "Evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_commandId_fkey" FOREIGN KEY ("commandId") REFERENCES "Command"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_parentTaskId_fkey" FOREIGN KEY ("parentTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskDependency" ADD CONSTRAINT "TaskDependency_dependsOnTaskId_fkey" FOREIGN KEY ("dependsOnTaskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionJob" ADD CONSTRAINT "ExecutionJob_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionJob" ADD CONSTRAINT "ExecutionJob_browserProfileId_fkey" FOREIGN KEY ("browserProfileId") REFERENCES "BrowserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionJob" ADD CONSTRAINT "ExecutionJob_contextSnapshotId_fkey" FOREIGN KEY ("contextSnapshotId") REFERENCES "ExecutionContextSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionJob" ADD CONSTRAINT "ExecutionJob_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderHealth" ADD CONSTRAINT "ProviderHealth_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderIncident" ADD CONSTRAINT "ProviderIncident_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ProviderDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanInterventionRequest" ADD CONSTRAINT "HumanInterventionRequest_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanInterventionRequest" ADD CONSTRAINT "HumanInterventionRequest_executionJobId_fkey" FOREIGN KEY ("executionJobId") REFERENCES "ExecutionJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanInterventionRequest" ADD CONSTRAINT "HumanInterventionRequest_browserProfileId_fkey" FOREIGN KEY ("browserProfileId") REFERENCES "BrowserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemporarySecret" ADD CONSTRAINT "TemporarySecret_humanInterventionRequestId_fkey" FOREIGN KEY ("humanInterventionRequestId") REFERENCES "HumanInterventionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Creative" ADD CONSTRAINT "Creative_createdByTaskId_fkey" FOREIGN KEY ("createdByTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeVersion" ADD CONSTRAINT "CreativeVersion_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "Creative"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreativeVersion" ADD CONSTRAINT "CreativeVersion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_executionJobId_fkey" FOREIGN KEY ("executionJobId") REFERENCES "ExecutionJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionVerification" ADD CONSTRAINT "ExecutionVerification_executionJobId_fkey" FOREIGN KEY ("executionJobId") REFERENCES "ExecutionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorSource" ADD CONSTRAINT "CompetitorSource_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorSnapshot" ADD CONSTRAINT "CompetitorSnapshot_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorChange" ADD CONSTRAINT "CompetitorChange_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorChange" ADD CONSTRAINT "CompetitorChange_fromSnapshotId_fkey" FOREIGN KEY ("fromSnapshotId") REFERENCES "CompetitorSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorChange" ADD CONSTRAINT "CompetitorChange_toSnapshotId_fkey" FOREIGN KEY ("toSnapshotId") REFERENCES "CompetitorSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorInsight" ADD CONSTRAINT "CompetitorInsight_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorInsight" ADD CONSTRAINT "CompetitorInsight_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "CompetitorChange"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_insightId_fkey" FOREIGN KEY ("insightId") REFERENCES "CompetitorInsight"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgencyIdea" ADD CONSTRAINT "AgencyIdea_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_browserProfileId_fkey" FOREIGN KEY ("browserProfileId") REFERENCES "BrowserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "IntegrationCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectSkill" ADD CONSTRAINT "ProjectSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_executionJobId_fkey" FOREIGN KEY ("executionJobId") REFERENCES "ExecutionJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeadLetterJob" ADD CONSTRAINT "DeadLetterJob_executionJobId_fkey" FOREIGN KEY ("executionJobId") REFERENCES "ExecutionJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramUserBinding" ADD CONSTRAINT "TelegramUserBinding_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "TelegramConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramConversation" ADD CONSTRAINT "TelegramConversation_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "TelegramUserBinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramMessage" ADD CONSTRAINT "TelegramMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "TelegramConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramAction" ADD CONSTRAINT "TelegramAction_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "TelegramConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
