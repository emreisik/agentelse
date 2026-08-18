-- AlterEnum
BEGIN;
CREATE TYPE "ActorType_new" AS ENUM ('USER', 'SYSTEM', 'AI', 'OPENCLAW', 'API', 'PARTNER');
ALTER TABLE "BrandDecision" ALTER COLUMN "decidedByType" TYPE "ActorType_new" USING ("decidedByType"::text::"ActorType_new");
ALTER TABLE "Task" ALTER COLUMN "createdByType" TYPE "ActorType_new" USING ("createdByType"::text::"ActorType_new");
ALTER TABLE "Approval" ALTER COLUMN "requestedByType" TYPE "ActorType_new" USING ("requestedByType"::text::"ActorType_new");
ALTER TABLE "AuditLog" ALTER COLUMN "actorType" TYPE "ActorType_new" USING ("actorType"::text::"ActorType_new");
ALTER TYPE "ActorType" RENAME TO "ActorType_old";
ALTER TYPE "ActorType_new" RENAME TO "ActorType";
DROP TYPE "public"."ActorType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "CommandSource_new" AS ENUM ('WEB', 'API', 'SYSTEM', 'SCHEDULE');
ALTER TABLE "Command" ALTER COLUMN "source" TYPE "CommandSource_new" USING ("source"::text::"CommandSource_new");
ALTER TYPE "CommandSource" RENAME TO "CommandSource_old";
ALTER TYPE "CommandSource_new" RENAME TO "CommandSource";
DROP TYPE "public"."CommandSource_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "TelegramAction" DROP CONSTRAINT "TelegramAction_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "TelegramConversation" DROP CONSTRAINT "TelegramConversation_bindingId_fkey";

-- DropForeignKey
ALTER TABLE "TelegramMessage" DROP CONSTRAINT "TelegramMessage_conversationId_fkey";

-- DropForeignKey
ALTER TABLE "TelegramUserBinding" DROP CONSTRAINT "TelegramUserBinding_connectionId_fkey";

-- AlterTable
ALTER TABLE "Command" DROP COLUMN "telegramConversationId";

-- DropTable
DROP TABLE "TelegramAction";

-- DropTable
DROP TABLE "TelegramConnection";

-- DropTable
DROP TABLE "TelegramConversation";

-- DropTable
DROP TABLE "TelegramMessage";

-- DropTable
DROP TABLE "TelegramUserBinding";

