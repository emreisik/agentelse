-- Google Analytics ve Search Console artık ayrı entegrasyonlar: tek "google"
-- kaydı iki kayda bölünür. İkisi de mevcut refresh token'ı paylaşır (eski
-- grant her iki scope'u da içeriyor), böylece kullanıcının yeniden bağlanması
-- gerekmez. Her kayıt yalnızca kendi servisinin metadata alanlarını taşır.
-- Idempotent: tekrar çalışırsa ON CONFLICT ile hiçbir şey eklenmez.

INSERT INTO "IntegrationCredential" (
  "id", "workspaceId", "projectId", "brandId", "provider", "accountLabel",
  "encryptedSecret", "metadata", "status", "createdAt", "updatedAt"
)
SELECT
  "id" || '_ga', "workspaceId", "projectId", "brandId", 'google_analytics',
  "accountLabel", "encryptedSecret",
  COALESCE("metadata", '{}'::jsonb) - ARRAY[
    'searchConsoleSites', 'gscListError', 'selectedSearchConsoleSite',
    'lastTestResult'
  ],
  "status", "createdAt", CURRENT_TIMESTAMP
FROM "IntegrationCredential"
WHERE "provider" = 'google'
ON CONFLICT ("projectId", "provider") DO NOTHING;

INSERT INTO "IntegrationCredential" (
  "id", "workspaceId", "projectId", "brandId", "provider", "accountLabel",
  "encryptedSecret", "metadata", "status", "createdAt", "updatedAt"
)
SELECT
  "id" || '_gsc', "workspaceId", "projectId", "brandId",
  'google_search_console', "accountLabel", "encryptedSecret",
  COALESCE("metadata", '{}'::jsonb) - ARRAY[
    'ga4Properties', 'ga4ListError', 'selectedGa4PropertyId',
    'selectedGa4PropertyName', 'previousAnalyticsSnapshot', 'lastTestResult'
  ],
  "status", "createdAt", CURRENT_TIMESTAMP
FROM "IntegrationCredential"
WHERE "provider" = 'google'
ON CONFLICT ("projectId", "provider") DO NOTHING;

DELETE FROM "IntegrationCredential" WHERE "provider" = 'google';
