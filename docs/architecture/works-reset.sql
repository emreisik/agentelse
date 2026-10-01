-- Works: eski tek sohbeti kalıcı silme (SİZİN çalıştıracağınız, geri alınamaz).
-- Bu dosya bir migration DEĞİLDİR ve prisma/migrations altına konmaz: paylaşımlı
-- canlı veritabanına otomatik uygulanmasın diye yalnızca dokümandır.
--
-- Silinen: sohbet satırları (Command) ve bunlara bağlı Task.commandId bağları
-- (ON DELETE SET NULL: görevlerin kendisi kalır). Silinmeyen: Task, Creative,
-- Library, Idea, takvim ve onay kayıtları.
--
-- Önce :project_id yerine projenin id'sini yazın ve SAYIMI çalıştırın.

-- 1) Sayım (silmeden önce bakın)
SELECT count(*) AS silinecek_satir
FROM "Command"
WHERE "projectId" = :'project_id'
  AND "workId" IS NULL
  AND "topic" IS NULL
  AND "ideaId" IS NULL;

-- 2) Silme (sayım doğruysa)
-- BEGIN;
-- DELETE FROM "Command"
-- WHERE "projectId" = :'project_id'
--   AND "workId" IS NULL
--   AND "topic" IS NULL
--   AND "ideaId" IS NULL;
-- COMMIT;
