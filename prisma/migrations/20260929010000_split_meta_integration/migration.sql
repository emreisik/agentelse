-- Instagram ve Meta Ads artık ayrı entegrasyonlar: tek "meta" kaydı iki kayda
-- bölünür. İkisi de mevcut long-lived token'ı paylaşır (eski grant her iki
-- scope grubunu da içeriyor), böylece kullanıcının yeniden bağlanması
-- gerekmez. Her kayıt yalnızca kendi servisinin metadata alanlarını taşır.
-- Instagram kaydında sadece bağlı Instagram Business hesabı olan Sayfalar
-- kalır. Idempotent: tekrar çalışırsa ON CONFLICT ile hiçbir şey eklenmez.

INSERT INTO "IntegrationCredential" (
  "id", "workspaceId", "projectId", "brandId", "provider", "accountLabel",
  "encryptedSecret", "metadata", "status", "createdAt", "updatedAt"
)
SELECT
  "id" || '_ig', "workspaceId", "projectId", "brandId", 'instagram',
  "accountLabel", "encryptedSecret",
  (COALESCE("metadata", '{}'::jsonb) - ARRAY[
    'adAccounts', 'adAccountsListError', 'selectedAdAccountId',
    'selectedAdAccountName', 'lastAdsPerformanceScanAt',
    'adsPerformanceScanFailureCount', 'previousScanSnapshot', 'lastTestResult'
  ]) || jsonb_build_object(
    'pages',
    COALESCE(
      jsonb_path_query_array(
        COALESCE("metadata"->'pages', '[]'::jsonb),
        '$[*] ? (@.instagramBusinessAccountId != null)'
      ),
      '[]'::jsonb
    )
  ),
  "status", "createdAt", CURRENT_TIMESTAMP
FROM "IntegrationCredential"
WHERE "provider" = 'meta'
ON CONFLICT ("projectId", "provider") DO NOTHING;

INSERT INTO "IntegrationCredential" (
  "id", "workspaceId", "projectId", "brandId", "provider", "accountLabel",
  "encryptedSecret", "metadata", "status", "createdAt", "updatedAt"
)
SELECT
  "id" || '_ads', "workspaceId", "projectId", "brandId", 'meta_ads',
  "accountLabel", "encryptedSecret",
  COALESCE("metadata", '{}'::jsonb) - 'lastTestResult',
  "status", "createdAt", CURRENT_TIMESTAMP
FROM "IntegrationCredential"
WHERE "provider" = 'meta'
ON CONFLICT ("projectId", "provider") DO NOTHING;

-- SocialAccount.credentialId eski kayda bağlıysa (FK onDelete: SetNull ile
-- kaybolmasın) yeni Instagram kaydına taşınır.
UPDATE "SocialAccount" AS sa
SET "credentialId" = ig."id"
FROM "IntegrationCredential" AS old
JOIN "IntegrationCredential" AS ig
  ON ig."projectId" = old."projectId" AND ig."provider" = 'instagram'
WHERE sa."credentialId" = old."id" AND old."provider" = 'meta';

DELETE FROM "IntegrationCredential" WHERE "provider" = 'meta';
