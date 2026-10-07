# Search Console entegrasyonu: faz notları (dizin)

Plan: [google-search-console-plan.md](google-search-console-plan.md). Her fazdan sonra bu dosya güncellenir (plan §9); ayrıntı faz başına ayrı dosyadadır.

| Faz   | Konu                                                          | Ayrıntı                                                          |
| ----- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| SC-F1 | Bağlantı katmanı (GA ile ortak)                               | [google-connections.md](google-connections.md)                   |
| SC-F2 | Arama ambarı + Search sayfası                                 | [search-analytics.md](search-analytics.md)                       |
| SC-F3 | Arama sağlığı ve teknik denetim                               | [search-health.md](search-health.md)                             |
| SC-F4 | SEO fırsat motoru                                             | [search-opportunities.md](search-opportunities.md)               |
| SC-F5 | Raporlama ve planlama                                         | [search-reports.md](search-reports.md)                           |
| SC-F6 | Öneri → uygulama → ölçüm döngüsü                              | [search-actions.md](search-actions.md)                           |
| SC-F7 | Aylık SEO içerik planı                                        | [search-content-plan.md](search-content-plan.md)                 |

## SC-F7 (7 Ekim 2026)

Aylık SEO içerik planı: `SEO_CONTENT_PLAN` bayrağı arkasında, canlı denenmedi. Kümelerden ve SO5/SO6 boşluklarından ayda en çok sınır kadar (varsayılan 4, en çok 12) makale slotu planlar; her slot bir `seo` fikri + DRAFT `seo.article` takvim parçasıdır; hiçbir kod APPROVED yapmaz, makale yine SEO Manager Review → Deliver yolundan geçer ve o sırada slot tüketilir. Tablolar: `SeoContentPlan`, `SeoContentSetting`.

**Aylık sınırın uygulandığı yerler:** planlayıcı (aynı Serializable işlemde yeniden sayar), `placeSeoArticle` (`SeoMonthlyCapError`), AI yazım öncesi ön kontrol (yalnız slotsuz makale, içinde bulunulan ay doluysa; §6.5 aylık AI makale sınırı) ve takvime koymadan önceki ön kontrol. Yalnız birincil Search Console bağı olan projelerde. **Muaf yollar:** "Mark as published", slotun kendi planlı ayındaki yazımı, aynı `commandId`'nin tekrarı; takvimde sürükleme de sınıra tabi değildir.

**Forget:** Disconnect, Delete stored data ve W1 saklaması (14 ay) planı KALICI SİLER: dokunulmamış slot parçaları ve plana ait fikirler gider; havuzdan alınmış fikir eski durumuna döner ya da (`search` kaynaklıysa) silinir; yazılmış makaleler kalır. Bayraktan bağımsızdır.

**Plandan kayıtlı sapmalar:**

1. "Migration: Yok" yerine `20261006220000_add_seo_content_plan` (Google'dan türeyen plan Disconnect'te silinmeli, sınır ayarı kalıcı olmalı).
2. SK14 (a) uygulandı; sınır ayarı Settings paneli yerine Search sayfasındaki bölümde.
3. "SEO makaleleri de taslağa girebilir" yerine haftalık taslakta not + "hafta dolu" sayımından çıkarma (plan kartı kalemi değil).
4. §6.5 aylık AI makale sınırı üretim öncesi ön kontrol olarak uygulandı.
5. W3'ün `pillarPageId`'si "en çok gösterimli sayfa" olduğundan "pillar yok" ölçütü pillar kalitesidir (ağırlıklı sıra > 20 ya da başlık+h1 kapsamı < %50).
