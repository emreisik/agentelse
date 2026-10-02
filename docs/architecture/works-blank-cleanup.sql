-- Works: birikmiş boş "New Work" kopyalarını arşivleme (SİZİN çalıştıracağınız).
-- Bu dosya bir migration DEĞİLDİR ve prisma/migrations altına konmaz: paylaşımlı
-- canlı veritabanına otomatik uygulanmasın diye yalnızca dokümandır.
--
-- Neden: "New Work" eskiden her tıklamada yeni satır ekliyordu. Artık boş bir Work
-- varsa o açılıyor ve aynı projedeki diğer boş kopyalar o anda arşivleniyor
-- (docs/works.md), yani bir projede "New Work"e bir kez basmak o projeyi zaten
-- temizler. Bu betik İSTEĞE BAĞLIDIR: tüm projelerdeki eski kopyaları, tek tek
-- girmeden, bir kerede arşivler. SİLMEZ, ARCHIVED yapar (kenar çubuğundan kalkar,
-- satır durur; geri almak için aşağıdaki 3. adım).
--
-- "Boş Work": aktif, Today değil, başlığı hâlâ "New Work" ve HİÇ sohbet satırı yok
-- (kodun kullandığı tanımın aynısı: WorkRepository.createOrReuseBlank). İçine bir
-- şey yazılmış ya da yeniden adlandırılmış Work'lere dokunulmaz. Her projede en son
-- etkin olan boş Work kalır, diğerleri arşivlenir.

-- 1) Sayım: boş Work'ü 2 ya da daha fazla olan projeler (önce buna bakın)
SELECT w."projectId", count(*) AS bos_work
FROM "Work" w
WHERE w."status" = 'ACTIVE'
  AND w."title" = 'New Work'
  AND left(w."id", 6) <> 'today_'
  AND NOT EXISTS (SELECT 1 FROM "Command" c WHERE c."workId" = w."id")
GROUP BY w."projectId"
HAVING count(*) > 1
ORDER BY bos_work DESC;

-- 2) Arşivle (sayım doğruysa; satırları görmek için önce SELECT'i çalıştırabilirsiniz)
-- BEGIN;
-- UPDATE "Work"
-- SET "status" = 'ARCHIVED', "updatedAt" = now()
-- WHERE "id" IN (
--   SELECT ranked."id"
--   FROM (
--     SELECT w."id",
--            row_number() OVER (
--              PARTITION BY w."projectId"
--              ORDER BY w."lastActivityAt" DESC, w."createdAt" DESC
--            ) AS sira
--     FROM "Work" w
--     WHERE w."status" = 'ACTIVE'
--       AND w."title" = 'New Work'
--       AND left(w."id", 6) <> 'today_'
--       AND NOT EXISTS (SELECT 1 FROM "Command" c WHERE c."workId" = w."id")
--   ) ranked
--   WHERE ranked.sira > 1
-- );
-- COMMIT;

-- 3) Geri alma (bir Work'ü yeniden görünür yapmak için; id'yi yazın)
-- UPDATE "Work" SET "status" = 'ACTIVE' WHERE "id" = :'work_id';
