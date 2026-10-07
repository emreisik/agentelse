# Agentelse · Google Search Console ve SEO Motoru: Mimari ve Uygulama Planı

Durum: Plan (6 Ekim 2026). SC-F1 bağlantı katmanı ve SC-F2 arama ambarı + Search sayfası uygulandı (6 Ekim 2026, bayraklı; [search-analytics.md](search-analytics.md)); SC-F3 arama sağlığı ve teknik denetim uygulandı (6 Ekim 2026, bayraklı; [search-health.md](search-health.md)); SC-F4 SEO fırsat motoru uygulandı (6 Ekim 2026, bayraklı; [search-opportunities.md](search-opportunities.md)); SC-F5 raporlama ve planlama uygulandı (6 Ekim 2026, bayraklı; [search-reports.md](search-reports.md)); SC-F6 öneri döngüsü uygulandı (bayraklı; [search-actions.md](search-actions.md)); SC-F7 ve sonrası henüz uygulanmadı.

> **Kapsam:** Google Search Console (GSC) entegrasyonu ve onun üzerine kurulan SEO motoru. Bu plan şunları kapsar: bağlantı ve kimlik; arama ambarı ve kalıcı arşiv; indeks ve teknik sağlık denetimi (URL Inspection, sitemap, robots, kendi site tarayıcımız, Core Web Vitals); SEO fırsat motoru; raporlama ve planlama; öneri → uygulama → ölçüm döngüsü. Sonraki aşamalarda içerik planı, CMS üzerinden onaylı uygulama ve AI arama görünürlüğü gelir.
>
> **Google Analytics ayrı bir entegrasyondur** ve kendi planı vardır: `docs/google-analytics-plan.md`. İkisi yalnız kod çekirdeğini paylaşır (§3.1). Bağlantı, izin, token, tablolar, işler, sağlık, bayraklar, arayüz ve silme ayrıdır. GA da bağlıysa §12'deki köprü fırsatları değerle önceliklendirir; bağlı değilse SEO motoru eksiksiz çalışır.
>
> **Dayanak:** GA planıyla aynı üç kod haritası ve araştırma raporu (6 Ekim 2026). Kod iddiaları repoda doğrulandı, örneğin `google-client.ts:343-446` (yalnız `query` boyutu; UTC ve "bugüne kadar" tarih), `modules/seo/research.ts:31-65`, `lib/module-flows/seo/quick-wins.ts:9-65`, `lib/module-flows/seo/on-page.ts:85-178`, `seo-rules.ts:16-79`, `brand/site-scan/extract.ts:1-4` (regex ayrıştırıcı) ve `security/safe-fetch.ts`. Repo kodunda değişiklik yapılmadı.
>
> **(doğrulanmalı):** Bu işareti taşıyan Google davranışları ve alan adları, sahibin gerçek Search Console mülkünde denenmeden koda bağlanmamalı.
>
> **Kurallar:** Arayüz İngilizce; doküman ve kod yorumları Türkçe. AGENTS.md uyarısı geçerli: Next.js 16 dokümanı `node_modules/next/dist/docs/` altında okunur. Ortak altyapı (`SystemHeartbeat`, `/api/health`, harici bekçi, `MonitorAlert`, `GoogleGrant`) GA ve Meta Ads planlarıyla tek kez kurulur; hangi plan önce uygulanırsa o kurar.

**İçindekiler:** 0 Özet · 1 Hedef davranış · 2 Mevcut durum ve boşluklar · 3 Hedef mimari (3.0–3.11) · 4 Veri modeli · 5 İşler, zamanlama ve kota bütçesi · 6 Profesyonel oyun kitabı · 7 Erişim ve Google doğrulaması · 8 Test · 9 Yol haritası · 10 Riskler · 11 Kararlar · 12 Google Analytics ile ilişki · Ek A Kaynaklar · Ek B Kısaltmalar

---

## 0. Özet

**Hedef.** Agentelse bir "AI SEO yöneticisi"ne dönüşecek. Bu yönetici:

- sitenin arama performansını kayıpsız toplayacak ve Google'ın 16 aylık sınırının ötesinde saklayacak,
- indekslenmeyi ve teknik sağlığı sürekli denetleyecek: kilit sayfada `noindex`, robots engeli, canonical sapması, indeks kaybı, sitemap hataları, Core Web Vitals,
- profesyonel yöntemlerle fırsat bulacak: vurucu mesafe, CTR açığı, içerik çürümesi, yamyamlaşma, içerik boşluğu, yükselen sorgular,
- fırsatları tahmini etkiyle (GA bağlıysa değerle) önceliklendirecek,
- her fırsatı somut bir değişikliğe çevirecek: başlık/meta, içerik yenileme, yeni makale, iç link, şema, teknik düzeltme,
- değişikliğin uygulandığını doğrulayacak ve 28-90 gün sonra etkisini kontrol grubuyla ölçüp öğrenecek.

Sonraki aşamalarda bu öğrenmelerle içerik planı, CMS üzerinden onaylı uygulama ve AI arama görünürlüğü çalışmaları gelir.

**Bugün nerede duruyoruz?** Search Console bağlantısı var ve 29 Eylül'den beri GA'dan ayrı bir entegrasyon (`google_search_console`). Şu yerlerde kullanılıyor: Analytics modülü (toplamlar ve ilk 5 sorgu), SEO Manager (son 28 günün "quick wins"i, pozisyon 8-20), fikir motoru (haftalık SEO fikirleri) ve günlük tarayıcı (ilk 25 sorgudan "content opportunity" sinyali). Ancak:

- Veri saklanmıyor. Google 16 aydan eski veriyi siliyor; Agentelse bugün saklamaya başlamazsa o geçmiş sonsuza kadar kaybolur.
- Yalnız `query` boyutu okunuyor. `page`, ülke, cihaz, arama türü ve arama görünümü hiç kullanılmıyor.
- Tarih aralıkları UTC ile hesaplanıyor ve "bugün"e kadar gidiyor. Oysa Search Console günleri Pasifik saatinde ve son 2-3 gün eksik; bu yüzden son günler sahte bir düşüş gibi görünüyor.
- İndeks, canonical, robots, sitemap ve URL Inspection hiç izlenmiyor. Site taraması yalnız ana sayfadan marka kimliği çıkarıyor (regex; robots ve sitemap okunmuyor).
- İki ayrı "fırsat" kuralı var: tarayıcıda ≥ 100 gösterim, CTR ≤ %2, pozisyon 8-20, en çok 3; quick wins'te pozisyon 8-20, ilk 10. Beklenen CTR modeli, marka ayrımı, çürüme ve yamyamlaşma analizi yok.
- Bulgular bir kez üretiliyor (sinyal parmak izinde tarih yok).
- SEO Manager'ın 9 on-page denetimi yalnız yeni makalelere uygulanıyor; sitenin canlı sayfaları hiç denetlenmiyor. Yayın elle yapılıyor; `WEBSITE_UPDATE` yeteneğinin yürütücüsü yok.
- Bağlantı katmanındaki sorunlar GA ile aynı: izin doğrulanmıyor, Disconnect token'ı tutuyor, koparılmış bağlantı geri gelebiliyor, eski ortak token, global sağlık, 100 token sınırı.

### En kritik 5 mimari karar

1. **Ayrı ve sertleştirilmiş bağlantı (SC-F1).** `webmasters.readonly` izniyle kendi grant'i, tabloları, işleri, sağlığı, bayrakları ve silme akışı. Site seçimi proje alan adına göre doğrulanır; Domain mülkü (`sc-domain:`) önerilir. Search Console'a hiçbir yazma yapılmaz: sitemap gönderimi yoktur (sahip kararı) ve `webmasters` yazma izni hiç istenmez.
2. **Arama ambarı ve kalıcı arşiv (SC-F2).** Ambar şunları tutar: arama türü başına günlük toplamlar (toplamın tek kaynağı), günlük ülke/cihaz/görünüm kırılımları, haftalık ve aylık sorgu, sayfa ve sorgu×sayfa özetleri (sözlük tablolarıyla). Bağlanınca 16 ay geri doldurulur ve Agentelse veriyi 16 ayın ötesinde de tutar. Kesinleşmiş ve taze veri (`dataState`) ayrı işaretlenir; günler Pasifik saatindedir.
3. **Sürekli arama sağlığı (SC-F3).** Bütçeli bir URL Inspection örnekleyicisi, sitemap ve robots izleme, robots ve sitemap'e saygılı kendi site tarayıcımız, kilit sayfalar için 6 saatte bir gerileme bekçisi, CrUX ile Core Web Vitals ve Google güncellemeleri takvimi. Sonuç bir "Search health" puanı ve tekilleşen uyarılardır.
4. **Deterministik SEO fırsat motoru (SC-F4).** Siteye özgü beklenen CTR eğrisi; vurucu mesafe, CTR açığı, çürüme (neden sınıflamasıyla), yamyamlaşma, içerik boşluğu, yükselen ve kaybedilen sorgular, iç link ve sayfa grubu eğilimleri; hepsi marka/marka dışı ayrımıyla. Öncelik = tahmini tıklama kazancı (GA bağlıysa × değer) × güven ÷ emek. LLM yalnız önerinin metnini yazar (başlık, meta, brief, şema) ve sayı üretemez.
5. **Öneri → uygulama → ölçüm döngüsü (SC-F6 – SC-F8).** Her öneri bir `SeoAction` kaydıdır ve şu zinciri izler: önerildi → kabul edildi → uygulandı (kullanıcı ya da SC-F8'de onaylı CMS yazması) → doğrulandı (tarayıcı ve URL Inspection değişikliği görür) → değerlendirildi (28/56/90 gün, kontrol gruplu) → öğrenme. İçerik üretimi mevcut SEO Manager'ı genişletir ("Refresh a page", "Fix the snippet"). Toplu ve kalitesiz AI içeriğine karşı raylar vardır.

### Fazlar

| Faz   | Tek satır                                                                                                                                                                     | Boyut |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| SC-F0 | Kod dışı önkoşullar (GA-F0 ile ortak) + koparılmış bağlantının yeniden ACTIVE olması hatasının düzeltilmesi (GA-F0 ile aynı)                                                  | S     |
| SC-F1 | Bağlantı ve kimlik: ortak çekirdek (GA-F1 ile birlikte), izin doğrulama, grant, akıllı iptal, site ve alan adı doğrulaması                                                    | M     |
| SC-F2 | Arama ambarı: günlük toplamlar, kırılımlar, haftalık ve aylık özetler, sözlükler, 16 ay geri doldurma, arşiv, kota yöneticisi, okuyucuların geçişi, "Search" sayfası v1       | L     |
| SC-F3 | Arama sağlığı: URL Inspection, sitemap ve robots, site tarayıcı, gerileme bekçisi, CWV, güncelleme takvimi, uyarılar ve puan                                                  | L     |
| SC-F4 | SEO fırsat motoru: CTR eğrisi, 16 kural, niyet ve konu kümeleri, önceliklendirme, bulgu kaydı, sinyal ve fikir akışı, sohbet araçları                                         | L     |
| SC-F5 | Raporlama ve planlama: haftalık/aylık/müşteri raporu, teşhis ağacı, SEO hedefleri ve tahmin, "SEO roadmap" kartı                                                              | M     |
| SC-F6 | Öneri döngüsü: `SeoAction`, SEO Manager'da "Refresh a page" ve "Fix the snippet", doğrulama, kontrol gruplu değerlendirme, öğrenmeler                                         | M     |
| SC-F7 | İçerik planı: konu kümeleri (pillar/cluster), aylık SEO içerik takvimi, iç link planı, içerik kalite rayları                                                                  | M     |
| SC-F8 | Uygulama katmanı: ayrı CMS entegrasyonları (önce WordPress), onaylı ve geri alınabilir yazma, AI arama görünürlüğü (GEO/AEO). Search Console'a yazma ve sitemap gönderimi yok | L     |
| SC-F9 | Ajans ve büyük site: BigQuery toplu dışa aktarımı, sayfa grupları yönetimi, isteğe bağlı ücretli SERP verisi, bölünmüş SEO testleri, çoklu site                               | L     |

Faz kodları `SC-F*` biçimindedir. Boyut ölçeği GA ve Meta planlarıyla aynıdır: **S** ≈ 1-2 gün, **M** ≈ 3-5 gün, **L** ≈ 1-2 hafta. Her faz tek başına canlıya çıkabilir ve kendi başına değer üretir.

**İki Google planının birlikte sırası (öneri):** GA-F0 + SC-F0 → GA-F1 + SC-F1 (ortak çekirdek ve bağlantı düzeltmeleri tek seferde) → GA-F2 → GA-F3 → SC-F2 → SC-F3 → GA-F4 → SC-F4 → GA-F5 / SC-F5 → GA-F6 → SC-F6 → SC-F7 → … SC-F2 erken başlamalıdır: Google'ın 16 aylık penceresinden düşen her hafta geri gelmez. Search Console'u öne almak istenirse SC-F2, GA-F2'den önce yapılabilir; iki plan birbirini beklemez.

### Sahibin onayladığı ilke (6 Ekim 2026)

**Search Console ve Google Analytics ayrı ayrı bağlanır.** Bugünkü arayüzdeki gibi iki ayrı kutucuk, iki ayrı "Connect" düğmesi ve iki ayrı Google onay ekranı vardır; her onay ekranı yalnız kendi iznini ister. Token, site seçimi, Disconnect, veri silme, senkron, sağlık, raporlar ve sohbetler de ayrıdır. Bu plandaki hiçbir adım ikisini tek bağlantıda birleştirmez. "Use existing connection" yalnız aynı servisin bağlantısını başka bir projede yeniden kullanır; "GA-F1 + SC-F1 birlikte" yalnız ortak kodun bir kez yazılması demektir.

**Tek Google Cloud projesi, tek Google doğrulaması (SK1 = GK1, 6 Ekim 2026).** Mevcut proje ve OAuth istemcisi kalır; ikinci bir Cloud projesi ve ikinci bir Google doğrulaması yapılmaz. `webmasters.readonly`, GA'nın `analytics.readonly` izniyle aynı doğrulama başvurusunda yer alır. Google izin kaydını proje başına tuttuğu için, bizim Disconnect'imizin GA'yı koparmaması "akıllı iptal" kuralıyla sağlanır (GA planı §3.2).

**Sitemap gönderimi yapılmaz (SK10, 6 Ekim 2026).** Search Console entegrasyonu her zaman salt okunurdur; `webmasters` yazma izni hiç istenmez, bu yüzden Search Console için ek bir Google izin incelemesi de gerekmez. Agentelse sitemap'leri yalnız okur ve sorunlarını raporlar (SH11, SH12); gönderim gerekiyorsa kullanıcı bunu kendi Search Console'unda yapar ve rehber ona yolu gösterir.

### Sahibin hemen vermesi gereken kararlar (SC-F0 – SC-F3'ü bloklayanlar)

Tam liste §11'de. Cloud projesi kararı (SK1 = GK1) verildi. GA planındaki GK2, GK3, GK5-GK8, GK11, GK12, GK15 ve GK17 kararları Search Console için de aynen geçerlidir (SK2, SK16 ve SK20 bunları buraya bağlar); ayrı ayrı onaylanabilirler. Sahip 6 Ekim'de "eksikleri tamamla" dedi: bekleyen her kararda **"Önerilen" seçenek, sahip aksini söyleyene kadar varsayılan kabul edilir.** Sahibin elinde olan adımlar yine sahipte kalır: yeni bağımlılık (SK4, kodlanırken ayrıca sorulur), API anahtarı (SK7), hukuki görüş, Google Cloud Console ayarları.

1. **Arşiv (SK3).** Agentelse Search Console verisini 16 ayın ötesinde saklasın: günlük toplamlar ve aylık özetler süresiz, haftalık sorgu/sayfa özetleri 36 ay. Bağlanırken açık beyan olsun; Settings'ten kapatılabilsin. _(Önerilen)_
2. **Site tarayıcısı için yeni bağımlılık (SK4).** HTML ayrıştırma için `htmlparser2` eklensin; mevcut regex çıkarıcı tam sayfa denetimine yetmiyor. _(Önerilen; global kurallar gereği yeni bağımlılık sahibin onayıyla eklenir)_
3. **Tarama sınırları ve kimlik (SK5).** KOBİ'de haftada en çok 500 sayfa, saniyede 1 istek, robots.txt'ye uyum. UA `AgentelseSiteAudit/1.0 (+https://agentelse.com/bot)` ve açıklama sayfası. Yalnız doğrulanmış alan adları taranır. _(Önerilen)_
4. **URL Inspection bütçesi (SK6).** Site başına günde 200 inceleme (Google sınırı 2.000). _(Önerilen)_
5. **CrUX için API anahtarı (SK7).** Yalnız Chrome UX Report API'ye kısıtlı yeni bir `GOOGLE_API_KEY`. _(Önerilen)_
6. **Raporların yeri (SK9).** Proje başına bir "Search & SEO" sohbeti. _(Önerilen)_

---

## 1. Hedef davranış: "AI SEO yöneticisi"

### 1.1 Profesyonel rutin

| Ritim                                                                  | AI SEO yöneticisi ne yapar                                                                                                                                                                                                        | Çıktı                                                                        | İnsan ne yapar                 |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------ |
| **Sürekli** (6 saatte bir)                                             | Kilit sayfalar (ana sayfa + tıklamada ilk 20) için durum kodu, `noindex` (meta ve `X-Robots-Tag`), canonical ve başlık; robots.txt değişimi; saatlik veriyle erken düşüş işareti; senkron ve token nabzı                          | Uyarı (yalnız sorun varsa)                                                   | Kritik uyarıda bakar           |
| **Günlük**                                                             | Kesinleşen günleri (genelde D-3) ambara yazar, son günleri "fresh" olarak tazeler. Toplam anomalisi (marka dışı tıklama), sitemap durumu, URL Inspection bütçesi (yeni, değişen ve düşen sayfalar), Google güncellemeleri takvimi | "Search pulse" kartı (yalnız not edilecek bir şey varsa)                     | Okur                           |
| **Haftalık** (son haftanın verisi kesinleşince; tipik olarak Çarşamba) | Haftalık sorgu ve sayfa özetleri; fırsat motoru; yükselen ve kaybedilen sorgular; yamyamlaşma; vadesi gelen eylem değerlendirmeleri; tam site taraması; CWV (CrUX)                                                                | Haftalık SEO raporu + en fazla 5 öneri; fikir havuzuna kanıtlı SEO fikirleri | Önerileri kabul ya da ret eder |
| **Aylık** (ayın 4'ü; son günler kesinleşsin diye)                      | Aylık rapor / müşteri raporu (marka dışı tıklama, kazanan ve kaybeden sayfalar, indeks kapsamı tahmini, CWV, eylemler ve sonuçları); çürüme analizi (3 aylık pencere + YoY); SEO hedefleri ve tahmin; gelecek ayın içerik planı   | Aylık rapor + "SEO roadmap" kartı                                            | Planı onaylar                  |
| **Çeyreklik**                                                          | Derin teknik denetim (site mimarisi, iç link grafiği, yetim sayfalar), içerik envanteri (birleştir, yenile, kaldır), AI arama görünürlüğü gözden geçirme                                                                          | Denetim raporu                                                               | Onaylar                        |
| **Platform** (operatör)                                                | API hataları, kotalar, URL Inspection kullanımı; Search Console'daki yeni özelliklerin API'ye gelip gelmediği (Gen-AI raporu, "Web: multimodal", platform mülkleri)                                                               | /health                                                                      | İzler                          |

### 1.2 Otonomi

| Seviye (UI)                     | Ne yapılır                                                                                                  | Asla yapılmaz                                                                                                                                                     | Önkoşul                             | Varsayılan |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------- |
| **Read & suggest**              | Okuma, denetim, analiz, rapor, öneri ve hazır metin (başlık, meta, makale, şema). Uygulama kullanıcıdadır   | Sitede değişiklik; Google'a gönderim                                                                                                                              | —                                   | **Evet**   |
| **Apply with approval** (SC-F8) | Bağlı CMS'te taslak oluşturma; başlık, meta ve şema güncelleme. Her biri onaylı, kayıtlı ve geri alınabilir | Onaysız yayın; sayfa silme; toplu içerik yayını; Search Console'a herhangi bir yazma (sitemap gönderimi dahil); Indexing API'nin uygun olmayan içerikte kullanımı | CMS entegrasyonu, OWNER/ADMIN onayı | Hayır      |

- Otomatik (onaysız) yayın hiçbir seviyede yoktur.
- Search Console'daki "Request indexing" düğmesinin API karşılığı yoktur. Indexing API yalnız iş ilanı ve canlı yayın içeriği içindir ve kullanılmaz.

### 1.3 Tasarım ilkeleri

- **SEO yavaş ve gürültülüdür.** Kararlar 28 günlük pencerelerle, asgari gösterim eşikleriyle, mevsimsellik (YoY) ve Google güncellemeleri takvimiyle verilir. Kapıyı geçmeyen sonuç "directional" etiketi taşır.
- **Toplam tek kaynaktan.** Toplamlar mülk düzeyindeki sorgudan gelir; sorgu satırları toplanmaz, çünkü anonim sorgular toplamda vardır ama satırlarda yoktur. UI: "23% of clicks come from queries Google doesn't show."
- **Marka ve marka dışı ayrı.** Google'ın marka filtresi yalnız arayüzde var; Agentelse kendi sınıflandırmasını yapar (Brand Brain adı, alan adı, ürün ve kişi adları, kullanıcı düzenlemesi). Asıl SEO KPI'ı marka dışı tıklamadır.
- **Bağlam.** "Search Console days (Pacific Time)", "Final data through Oct 3", "Fresh (may change)". Toplama türü (mülk / sayfa) tabloda yazılır. Pozisyon bir "ortalama en üst pozisyon"dur; sıralama takibi değildir ve öyle sunulmaz.
- **AI Overviews ve AI Mode.** İkisi de Web arama türüne dahildir. AI Overview'daki bütün linkler aynı pozisyonu paylaşır; AI Mode'daki takip soruları yeni sorgu sayılır. Bu yüzden bir CTR düşüşünün bir kısmı AI özetlerinden gelebilir. Çürüme sınıflaması bunu "CTR loss at stable position" olarak ayırır ve böyle yazar.
- **KOBİ gerçekliği.** Az veri olan sitede (ayda 1.000 gösterimin altında) motor "içerik ve indeks önce" moduna geçer: indeks sağlığı, teknik denetim ve içerik planı öne çıkar; sorgu kuralları sessiz kalır.
- **Kalite önce.** Google'ın spam politikalarına (toplu içerik kötüye kullanımı, kapı sayfaları, site itibarının kötüye kullanımı) aykırı hiçbir şey önerilmez (§6.5). İçerik insan onaylıdır.
- **Mevcut UI kuralları.** Arayüz İngilizce; tek tarih seçici; yeni dok ikonu yok; kartlar yerinde değişir; sohbet eylemleri anında ve canlıdır (SSE).
- **Rapor dili, AI bütçesi ve erişilebilirlik:** GA planı §1.3 ile aynıdır. Rapor ve öneri metinleri (başlık/meta varyantları, brief'ler) projenin içerik dilinde yazılır (SK20). Günlük AI sınırı dolarsa raporlar özetsiz ama zamanında çıkar; başlık/meta önerisi gibi AI isteyen işler ertesi güne kalır ve kartta bunu söyler.
- **Görmediklerimizi söyleriz.** API'nin vermediği raporlar (§3.4) için Agentelse "her şey yolunda" demez; düşüş teşhisinde kullanıcıdan o ekranlara bakmasını ister.

### 1.4 Başarı ölçütleri

| Ölçüt                                                     | Hedef                                     |
| --------------------------------------------------------- | ----------------------------------------- |
| Ambar doğruluğu: kesinleşmiş günün toplamı GSC arayüzüyle | ±%1                                       |
| Kesinleşen günün ambara girişi                            | Google'da göründükten sonra ≤ 6 saat      |
| Kilit sayfada `noindex` ya da robots engelinin tespiti    | ≤ 6 saat                                  |
| Yeni sayfanın indeks durumunun bilinmesi                  | Sitemap'te göründükten sonra ≤ 7 gün      |
| URL Inspection kullanımı                                  | Günlük bütçenin altında                   |
| Yanlış kritik uyarı oranı                                 | < %10                                     |
| Önerilerin kabul oranı                                    | ≥ %40                                     |
| Uygulanan eylemlerin değerlendirme oranı                  | Pencere dolunca ≥ %80'i bir sonuca ulaşır |
| Raporlarda doğrulanmamış sayı                             | 0                                         |
| Site taramasının hedef siteye yükü                        | ≤ 1 istek/sn; robots.txt'ye %100 uyum     |

---

## 2. Mevcut durum ve boşluk analizi

### 2.1 Bileşen envanteri: korunacak, yeniden düzenlenecek, kaldırılacak

| Bileşen                                                                                                                                                     | Bugün                                                                                                                                                                  | Karar                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google-client.ts` GSC fonksiyonları (`fetchSearchConsoleReport` `:343-387`, `fetchSearchConsoleQueryRows` `:403-446`, `listSearchConsoleSites` `:288-310`) | Toplam (boyutsuz, `rowLimit: 1`), `query`/`page` satırları; UTC tarih, bugüne kadar; `dataState` yok; doğrulanmamış siteler listeden atılıyor (doğru)                  | **Yeniden düzenle:** `src/server/integrations/search-console/{search-analytics,sites,sitemaps,url-inspection,governor}.ts`. PT tarihleri, `dataState` ve sayfalama eklenir                            |
| `modules/analytics/google.ts` `collectSearchConsole` (`:163-219`)                                                                                           | Toplam + ilk 5 sorgu, canlı okuma                                                                                                                                      | Ambara bağlanır; marka ayrımı ve sayfa tablosu eklenir                                                                                                                                                |
| SEO Manager (`src/server/modules/seo/*`, `src/lib/module-flows/seo/*`, `seo-flow-actions.ts`)                                                               | Brief → Plan (web araştırması + quick wins) → Create (makale) → Review (9 on-page denetimi, en fazla 5 Rewrite) → Publish (kopyala, takvime ekle, "Mark as published") | **Korunur ve genişler:** quick wins ambardan ve CTR eğrisiyle gelir; yeni modlar "Refresh a page" ve "Fix the snippet"; fırsattan önceden doldurulmuş brief; yayın sonrası doğrulama ve değerlendirme |
| `quick-wins.ts` (`:9-65`) ve `seo-rules.ts` `CONTENT_OPPORTUNITY` (`:16-79`)                                                                                | Eşikleri farklı iki ayrı kural                                                                                                                                         | Tek kural kütüphanesine (`src/lib/seo/rules/*`) taşınır; tarayıcıdaki GSC kısmı SC-F4'te kalkar                                                                                                       |
| Fikir motoru `generateSeoIdeas` (`idea-modules.ts:175-183,287-309`)                                                                                         | Haftalık, quick wins'e dayalı                                                                                                                                          | Korunur; fırsat motorunun kanıtlı fikirleriyle beslenir (içerik boşluğu, yükselen sorgu)                                                                                                              |
| Marka site taraması (`src/server/brand/site-scan/*`) ve `safe-fetch.ts`                                                                                     | Tek sayfa, regex; SSRF korumaları sağlam                                                                                                                               | Marka taraması aynen kalır. SEO tarayıcısı ayrı bir modül olarak `safe-fetch`'i kullanır                                                                                                              |
| `content-channels.ts` `seo` kanalı ("Blog / SEO", elle yayın, `:201-218`)                                                                                   | CMS yok                                                                                                                                                                | Korunur; SC-F8'de bir CMS bağlanınca "Publish to WordPress" gibi bir yol açılır                                                                                                                       |
| `CapabilityKey`: `SEO_RESEARCH`, `SEO_ANALYSIS`, `WEBSITE_UPDATE`                                                                                           | `WEBSITE_UPDATE`'in yürütücüsü yok                                                                                                                                     | SC-F8'de CMS sağlayıcısı `WEBSITE_UPDATE`'i üstlenir                                                                                                                                                  |
| Signal kategorisi `SEO`, departman `SEO`                                                                                                                    | Var                                                                                                                                                                    | Korunur                                                                                                                                                                                               |
| `apps/marketing` (robots, sitemap, JSON-LD; GA yok)                                                                                                         | agentelse.com                                                                                                                                                          | Kendi sitemizde ilk deneme alanı (dogfooding)                                                                                                                                                         |

### 2.2 Boşluk tablosu

| #   | Boşluk                                          | Önem               | Kanıt                                                                                                              | Etki                                                                      | Faz           |
| --- | ----------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------- |
| 1   | Veri saklanmıyor; 16 ay sonra geçmiş kayboluyor | Yüksek             | Hiçbir GSC tablosu yok; Google yalnız 16 ay tutuyor                                                                | Uzun dönem eğilim, YoY, çürüme ve eylem değerlendirmesi yapılamıyor       | SC-F2         |
| 2   | Tarih hatası                                    | Yüksek             | `google-client.ts:353-357, 410-413`: UTC + bugüne kadar. GSC günleri PT'de ve son 2-3 gün eksik                    | Son günler sahte düşüş gösteriyor; dönem karşılaştırmaları kayık          | SC-F2         |
| 3   | Yalnız `query` boyutu                           | Yüksek             | `page` desteği var ama kullanılmıyor (`:406`); ülke, cihaz, tür ve görünüm hiç yok                                 | Sayfa düzeyinde hiçbir analiz yok                                         | SC-F2         |
| 4   | Satır sınırları                                 | Orta               | Tarayıcı 25, quick wins 1.000 satır okuyor; sayfalama yok                                                          | Fırsatların çoğu görünmüyor                                               | SC-F2         |
| 5   | İndeks ve teknik izleme yok                     | Yüksek             | URL Inspection, sitemap ve robots hiç çağrılmıyor; site taraması tek sayfa ve marka amaçlı                         | Yanlışlıkla eklenen `noindex` ya da robots engeli haftalarca fark edilmez | SC-F3         |
| 6   | Canlı sayfalar denetlenmiyor                    | Orta               | 9 on-page denetimi yalnız yeni makalede (`on-page.ts:85-178`)                                                      | Mevcut içerik iyileştirilemiyor                                           | SC-F3 / SC-F6 |
| 7   | Fırsat kuralları sığ ve çift                    | Orta               | `seo-rules.ts` ve `quick-wins.ts` farklı eşikler kullanıyor; beklenen CTR, marka ayrımı, çürüme ve yamyamlaşma yok | Yanlış önceliklendirme                                                    | SC-F4         |
| 8   | Bulgu bir kez üretiliyor                        | Yüksek             | Tarihsiz `externalRef` (`google-analytics-scanner.ts:170`)                                                         | Aynı sorgu fırsatı bir daha hiç önerilmez                                 | SC-F4         |
| 9   | Mülk ↔ alan adı doğrulaması yok                 | Orta               | SEO varsayılanı domain yoksa GSC mülkünü kullanıyor (`modules/seo/defaults.ts:14-31`); tersine bir kontrol yok     | Yanlış site analiz edilebilir                                             | SC-F1         |
| 10  | Öneri → sonuç döngüsü yok                       | Yüksek             | SEO Manager "Mark as published"da bitiyor                                                                          | Hangi değişikliğin işe yaradığı öğrenilmiyor                              | SC-F6         |
| 11  | Yayın elle; CMS yok                             | Orta               | `content-channels.ts:201-218`; `WEBSITE_UPDATE` yürütücüsüz (`work-plan-builder.ts:89`)                            | Uygulamada sürtünme                                                       | SC-F8         |
| 12  | SEO Manager açık kalanları                      | Orta               | `docs/modules.md:83` (Work başına tek kart, ~1 dk süren ve sekmeyi bekleten eylemler…)                             | Kötü deneyim                                                              | SC-F6         |
| 13  | Bağlantı katmanı sorunları                      | Yüksek             | GA planı §2.2 #1-#7                                                                                                | GA ile aynı                                                               | SC-F0 / SC-F1 |
| 14  | Gizlilik metninde Search Console yok            | Yüksek (doğrulama) | `privacy/page.tsx:102-115`                                                                                         | Google doğrulaması reddedilebilir                                         | SC-F1         |

### 2.3 SEO Manager açık kalanlarının karşılığı (`docs/modules.md:83`)

| Açık kalan                                                                                  | Plandaki karşılığı                                                                                         |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Work başına tek SEO kartı; yayınlanmış kartta "Write another" yok                           | SC-F6: "Write another" ve "Refresh a page" aynı sohbette yeni bir kart açar                                |
| Brief dili proje dilinden farklıysa hangi talimatın kazanacağı modele kalmış                | SC-F6: Brief dili kesin kuraldır; marka kuralları o dildeki haliyle gider (`brandRuleLanguageOf`)          |
| Araştırma ve yazma ~1 dk sürüyor; aynı sekmedeki diğer eylemler bekliyor                    | SC-F6: iş arka planda `driveJobInline` + SSE ile canlı ilerler ("sohbet eylemleri anında ve canlı" ilkesi) |
| Takvimde taşınan ya da yayınlanan parça "Mark as published"a basılana dek kartta görünmüyor | SC-F6: yayın, tarayıcının sayfayı canlıda görmesiyle de doğrulanır (`SeoAction` VERIFIED)                  |
| `liveSlotCount` yalnız content-plan-draft kartlarını sayıyor                                | SC-F6: SEO kartları da sayılır                                                                             |

**SC-F6 (7 Ekim 2026): beş madde de kapandı** (`SEO_ACTIONS` bayrağı altında; [search-actions.md](search-actions.md)). Kayıtlı sapma: `driveJobInline` yerine `next/server` `after()` + veritabanı yoklamalı SSE (SEO Manager koşuları kuyruk Job'u değil kart sahiplenmesidir; outbox olayı yoktur; deploy yeniden başlatmasında 5 dk TTL kartı açar).

---

## 3. Hedef mimari

### 3.0 Katmanlar ve veri akışı

```
[Arayüz]  Integrations → Search Console · "Search" sayfası · Brand sekmesi "Search" kartı · Analytics modül kartı
          · SEO Manager · "Search & SEO" sohbeti · fikir panosu · Works "Needs attention" · /health
     │ server action / sohbet aracı                                   ▲ okuma (ambar)
     ▼                                                                │
[Motorlar]  Arama sağlığı (SC-F3) ─uyarı─▶ MonitorAlert     Fırsat motoru (SC-F4) ─bulgu─▶ SeoFinding
            Raporlama + planlama (SC-F5)                    Öneri döngüsü (SC-F6) ─eylem─▶ SeoAction
            İçerik planı (SC-F7)                            Uygulama katmanı (SC-F8, ayrı CMS entegrasyonları)
     │                                                                ▲
     ▼                                                                │
[Ürün döngüsü]  Signal → Insight → Opportunity → Idea · SEO Manager · ProjectGoal · BrandLearning · GA köprüsü (§12)
     ▲
[Ambar]  GscSiteLink · GscDailyTotal · GscDailySlice · GscQuery / GscPage (sözlük) · GscWeekly* · GscMonthly*
         · GscUrlInspection · GscSitemap · SeoPage · SeoLink · SeoCwv · SearchUpdate
     ▲                                              ▲
[Senkron (SC-F2)]                         [Site tarayıcı + CrUX (SC-F3)]
  katalog · kesin/taze · geri doldurma       robots/sitemap okuma · safe-fetch · HTML denetimi
  · arşiv · kota yöneticisi                  · gerileme bekçisi · Core Web Vitals
     ▲                                              ▲
[GSC istemcisi]  Search Analytics · Sites · Sitemaps · URL Inspection        [Müşterinin sitesi] · [CrUX API]
     ▲
[Google çekirdeği, ortak kod]  OAuth · GoogleGrant · access token önbelleği · HTTP · hata kataloğu · PII süzgeci
     ▲
[Google]  searchconsole.googleapis.com · chromeuxreport.googleapis.com · oauth2.googleapis.com
```

**Fırsat → eylem → öğrenme akışı:**

```
Ambar (haftalık özetler, sözlük, tarama, inceleme, CWV)
        ▼
Özellikler: marka ayrımı, niyet, konu kümeleri, beklenen CTR eğrisi, sayfa grupları, güncelleme takvimi
        ▼
SEO kuralları (SO1-SO16) + istatistik kapıları ──▶ SeoFinding (tarihli parmak izi)
        ▼
Önceliklendirme: tahmini tıklama kazancı (× GA değeri) × güven ÷ emek
        ▼
AI: öneri metni (başlık/meta varyantları, brief, iç link çapası, JSON-LD) — sayı üretemez; kural ve şema doğrulaması
        ▼
Kullanıcı: Accept → SEO Manager ("Refresh a page" / "Fix the snippet" / "New article") ya da elle düzeltme
        ▼
SeoAction: APPLIED → VERIFIED (tarayıcı + URL Inspection) → EVALUATING (28/56/90 gün, kontrol grubu)
        ▼
WORKED / DIDNT / INCONCLUSIVE ──▶ BrandLearning ──▶ fikir motoru ve SEO Manager istemleri
```

### 3.1 Google erişim çekirdeği (ortak kod)

GA planı §3.1'deki tanım aynen geçerlidir: `src/server/integrations/google/{version,oauth,grant,access-token,revoke-policy,http,errors,error-catalog,pii}.ts`. Hangi plan önce uygulanırsa çekirdeği o yazar. Search Console'a özgü hata eşlemeleri:

| Sınıf            | Search Console işareti                                                        | Otomatik eylem                                                                                                              | Kullanıcı mesajı (UI)                                                            |
| ---------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| RATE_LIMIT       | 429 / "quota exceeded" (site ya da kullanıcı başına dakikada 1.200 sorgu)     | Site `rateLimitedUntil` = 60 sn                                                                                             | "Search Console asked us to slow down. Updates resume shortly."                  |
| LOAD_LIMIT       | Search Analytics "load" kotası (10 dakikalık kısa dönem, 1 günlük uzun dönem) | Kısa dönemde 15 dk beklenir. Uzun dönemde günün geri kalanında sorgu×sayfa ve uzun aralıklı sorgular durur; toplamlar sürer | Gösterilmez                                                                      |
| INSPECTION_QUOTA | URL Inspection: site başına günlük 2.000, dakikalık 600                       | PT gün sonuna kadar inceleme durur                                                                                          | "Daily URL inspection limit reached. More checks tomorrow."                      |
| PERMISSION       | 403: kullanıcının sitede yetkisi kalmadı (`siteUnverifiedUser`)               | Bağlantı SITE_ACCESS_LOST olur; site listesi yenilenir                                                                      | "Your Google account no longer has access to this Search Console property."      |
| SCOPE_MISSING    | Token'da `webmasters.readonly` yok (onay ekranında kutu kaldırılmış)          | Bağlantı NEEDS_PERMISSION olur; senkron durur                                                                               | "Agentelse needs permission to read Search Console. Reconnect and tick the box." |

Google bütün kota aşımlarında aynı "quota exceeded" hatasını döndürür. Hangi kotanın aşıldığı çağrı türünden ve kendi sayaçlarımızdan anlaşılır.

### 3.2 Bağlantı ve kimlik (SC-F1)

- **Akış:** GA ile aynıdır. İzinler `webmasters.readonly` + `userinfo.email`; token yanıtındaki `scope` doğrulanır; Google kimliği alınır; grant upsert edilir; PKCE kullanılır.
- **Site listesi:** `sites.list`. `siteOwner`, `siteFullUser` ve `siteRestrictedUser` kabul edilir; `siteUnverifiedUser` atlanır (bugünkü davranış). `siteRestrictedUser`'da bazı ayrıntılar kısıtlı olabilir (doğrulanmalı: URL Inspection'ın kısıtlı kullanıcıdaki davranışı).
- **Öneri ve doğrulama:**
  - Domain mülkü (`sc-domain:example.com`) bütün protokolleri ve alt alan adlarını kapsadığı için önerilir.
  - URL önekli mülkte (`https://www.example.com/`; sonda eğik çizgi şart) `http`/`https` ve `www` farkı uyarılır.
  - `Project.domain` ile eşleşmeyen bir site seçilirse uyarı gösterilir.
- **Platform mülkleri:** 7 Temmuz 2026'da eklenen Instagram/TikTok/X/YouTube mülkleri listede görünürse ayrı gösterilir ve web analizi için seçilemez (API desteği doğrulanmalı; gelecek kullanım SK17'de).
- **Grant, akıllı iptal, Disconnect, 30 günlük silme, roller ve eski ortak token:** GA planı §3.2 aynen geçerlidir. Search Console'un Disconnect'inde, aynı Google hesabının aktif bir GA bağlantısı varsa Google'da iptal çağrılmaz.

### 3.3 Arama ambarı (SC-F2)

**Yeni dosyalar:** `src/server/integrations/search-console/*`; `src/server/seo/sync/{runner,daily,weekly,monthly,backfill,sitemaps}.ts`; `src/server/seo/store.ts` (okuyucuların tek kapısı). Saf yardımcılar `src/lib/seo/{dates,brand-terms,normalize}.ts` altında.

**Sorgu kataloğu:**

| Anahtar                          | Boyutlar                    | Tür (`type`)                                                      | Toplama                                      | `dataState`                | Tutma                                                                        |
| -------------------------------- | --------------------------- | ----------------------------------------------------------------- | -------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| `totals`                         | `date`                      | web, image, video, news, discover, googleNews (yalnız veri varsa) | `byProperty` (discover/googleNews'te `auto`) | `final` + son günler `all` | Günlük → `GscDailyTotal`                                                     |
| `breakdown_country`              | `date`, `country`           | web                                                               | auto                                         | final                      | Günlük, ilk 50 → `GscDailySlice`                                             |
| `breakdown_device`               | `date`, `device`            | web                                                               | auto                                         | final                      | Günlük → `GscDailySlice`                                                     |
| `breakdown_appearance`           | `date`, `searchAppearance`  | web                                                               | auto                                         | final                      | Günlük → `GscDailySlice`                                                     |
| `weekly_query`                   | `query` (ISO hafta aralığı) | web (+ image, varsa)                                              | auto                                         | final                      | Haftalık, tümü (sayfalı) → `GscWeeklyQuery`                                  |
| `weekly_page`                    | `page`                      | web                                                               | byPage                                       | final                      | Haftalık, tümü → `GscWeeklyPage`                                             |
| `weekly_query_page`              | `query`, `page`             | web                                                               | auto                                         | final                      | Haftalık, ilk 25.000 → `GscWeeklyQueryPage`                                  |
| `monthly_query` / `monthly_page` | `query` / `page`            | web                                                               | auto / byPage                                | final                      | Aylık, tümü → `GscMonthlyQuery` / `GscMonthlyPage` (kalıcı arşiv)            |
| `hourly`                         | `hour`                      | web                                                               | auto                                         | `hourly_all`               | Yalnız erken uyarı (SH2) ve "Search" sayfası açıkken; son 24 saat; saklanmaz |

**Günler, kesinleşme ve satırlar:**

- **Günler PT'dedir.** GSC'nin `date` değerleri ve tarih aralıkları Pasifik saatindedir. Haftalar PT'ye göre Pazartesi-Pazar alınır. UI'da proje saat dilimi yerine "Search Console day (PT)" yazılır.
- **Kesinleşme:** varsayılan `dataState=final` kullanılır ve günlük çekim yanıttaki `first_incomplete_date` ile sınırlanır. Son günler `dataState=all` ile "fresh" olarak çekilir, `fresh=true` işaretlenir ve kesinleşince üzerine yazılır. Aralık 2024'ten beri ortalama gecikme yarıya indi ve son 24 saat birkaç saatlik gecikmeyle geliyor; yine de API kılavuzu "tipik olarak 2-3 gün" diyor.
- **Satır sınırı:** istek başına 25.000 satır; `startRow` ile 0 satır dönene kadar sayfalanır. Google günde, arama türü başına en çok 50.000 satır verir (tıklamaya göre sıralı). Daha büyük siteler SC-F9'daki BigQuery dışa aktarımına yönlendirilir; ambar `truncated` işaretini tutar.
- **Anonim sorgular:** sorgu satırlarında yoktur, toplamda vardır. Her hafta "anonim pay" = 1 − Σ(sorgu tıklaması) / toplam tıklama saklanır ve gösterilir.
- **Pozisyonun yeniden toplanması:** satırlarda `positionWeighted = position × impressions` saklanır; haftalar birleştirilirken gösterimle ağırlıklı ortalama alınır. Bu, Google'ın kendi yöntemine yakın bir yaklaşımdır (doğrulanmalı); toplam pozisyon her zaman `totals`'tan gösterilir.

**Sözlükler:** `GscQuery` (metin, hash, marka mı, niyet, dil, konu kümesi, ilk ve son görülme haftası) ve `GscPage` (URL, yol, sayfa grubu, ilk ve son görülme). Sorgular ve URL'ler PII süzgecinden geçer; e-posta ya da telefon içeren nadir sorgular maskelenir.

**Geri doldurma** (bağlanınca, P2 şeridinde):

- Toplamlar 16 ay (tür başına tek istek, `date` boyutuyla); kırılımlar 16 ay; haftalık özetler 70 hafta; aylık özetler 16 ay.
- KOBİ sitesinde ~250-400 istek tutar; dakikada en çok 30 istekle 15-20 dakikada biter. Büyük sitede load kotası nedeniyle günlere yayılır.

**Kota yöneticisi** (site başına):

- Dakikada en çok 30 Search Analytics isteği (Google sınırı 1.200) ve en çok 2 eşzamanlı istek.
- Sorgu×sayfa ve 90 günden uzun aralıklar "ağır" sayılır; load kotası hatasında önce onlar durur.
- URL Inspection sayacı PT gününe göre tutulur.

**Kilit ve hata:** `GscSiteLink.syncLeaseUntil` CAS ile 5 dakikalık kilit; tick başına 3 site; hata alan sitede geri çekilme 5 dk → 6 sa.

**Okuyucuların geçişi** (`GSC_SYNC=true`): Analytics modülü, SEO Manager quick wins (artık CTR eğrisiyle), fikir motoru, sohbet araçları ve "Search" sayfası ambardan okur. Ambarda olmayan bir soru P1 canlı sorguya gider.

**Arşiv (SK3):** Google'ın 16 ayından eski veriler ambarda kalır. UI'da şu not görünür: "Older than Google keeps (archived by Agentelse)."

**Geliştirme ortamı:** `GSC_SYNC_DEV_PROJECTS` izin listesi; yerelde senkron varsayılan olarak kapalıdır.

**Mock modu:** `AGENTELSE_PROVIDER_MODE=mock` iken (CI ve yerel geliştirme) Search Console ve CrUX istemcileri kayıtlı fikstürlerden okur; site tarayıcı yalnız sahte `Transport` ile çalışır (`safe-fetch` DI deseni). Google'a, CrUX'a ya da herhangi bir siteye çağrı gitmez; mock verisi `isMock` ile işaretlenir ve canlı raporlara karışmaz.

### 3.4 Veri kalitesi

- **Toplamın kaynağı:** KPI'lar `totals`'tan gelir; kırılımlar toplanmaz. Anonim pay her tabloda görünür.
- **Kesin / taze:** son günler "Fresh (may change)" etiketiyle gösterilir.
- **PT günleri:** proje saat dilimine çevrilmez; etiketlenir.
- **Toplama türü:** mülk düzeyindeki CTR ve pozisyon, sayfa düzeyindekinden farklı hesaplanır; bu iki tür tablo karıştırılmaz.
- **Discover ve Google News:** az veride boş dönerler. "Web" türü Discover ve News'i içermez.
- **Yeni arama türleri ve raporlar:** "Web: multimodal" (24 Eylül 2026) ve Gen-AI performans raporu (Haziran 2026; yalnız gösterim) arayüzde var ama API'de belgelenmemiş. Operatör kontrolüyle izlenir; API'ye gelirlerse bayrakla eklenir.
- **Uzlaştırma bekçisi:** günlük toplam ile haftalık özetin toplamı (anonim pay hariç) tutarlı mı diye bakar; fark beklenen bandın dışındaysa SYNC_DATA_GAP uyarısı açar.

**API'de olmayan raporlar ve nasıl ele alındıkları** (Search Console API yalnız Search Analytics, Sites, Sitemaps ve URL Inspection'ı verir):

| Rapor (yalnız Search Console arayüzünde)                                       | Neden önemli                             | Agentelse ne yapar                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual actions (elle işlem)                                                    | Trafiği bir gecede düşürebilir           | Algılayamaz. Ani düşüşte teşhis ağacı kullanıcıdan bu ekrana bakmasını ister (§3.7)                                                                                                                                                                                          |
| Security issues (güvenlik sorunları)                                           | Hacklenen site uyarıyla gösterilir       | Algılayamaz; teşhis ağacında aynı adım. Tarayıcı, kilit sayfalarda beklenmedik dış yönlendirme ve gizli spam bağlantısı gibi belirtileri işaretler                                                                                                                           |
| Links (backlink ve iç link raporu)                                             | Otorite ve kayıp bağlantılar             | İç linkleri kendi tarayıcımız çıkarır (`SeoLink`). Dış bağlantı verisi yalnız ücretli bir sağlayıcıyla gelir (SK19)                                                                                                                                                          |
| Crawl stats (tarama istatistikleri)                                            | Googlebot'un siteyi ne sıklıkla taradığı | URL Inspection `lastCrawlTime` örnekleri ve sunucu yanıt süresiyle yaklaşık tahmin (SH13)                                                                                                                                                                                    |
| Page indexing                                                                  | Hangi sayfaların neden indekste olmadığı | URL Inspection örnekleminden aralıklı tahmin (SH9, SH10)                                                                                                                                                                                                                     |
| Core Web Vitals                                                                | Sayfa deneyimi                           | CrUX API (SH15)                                                                                                                                                                                                                                                              |
| Removals, Search Console Insights, Query groups, marka filtresi, Gen-AI raporu | Ek görünümler                            | Marka ayrımı ve konu kümelerini kendimiz hesaplarız; diğerleri API'ye gelirse bayrakla eklenir                                                                                                                                                                               |
| Arama hacmi (Search Console'da hiç yok)                                        | Henüz sıralanmadığımız sorguların talebi | GSC yalnız sıralandığımız sorguların gösterimini verir. Hacim için Google Ads Keyword Planner (ayrı bir entegrasyon + Ads geliştirici token'ı) ya da ücretli bir veri sağlayıcı gerekir (SK19); o zamana kadar SEO Manager'ın web araştırması ve GSC gösterimleri kullanılır |

### 3.5 Arama sağlığı ve teknik denetim (SC-F3)

**Yeni dosyalar:** `src/server/seo/health/{checks,inspection,sitemaps,robots,regression,cwv,updates,score,guides}.ts`; `src/server/seo/crawl/{crawler,frontier,fetcher,parse,audit,links}.ts`; saf yardımcılar `src/lib/seo/{robots-parser,sitemap-parser,html-audit,jsonld}.ts`.

**URL Inspection örnekleyicisi** (günlük bütçe; varsayılan site başına 200, SK6):

| Öncelik | Hangi URL'ler                                                |
| ------- | ------------------------------------------------------------ |
| P1      | SEO eylemiyle değişen sayfalar (doğrulama için)              |
| P2      | Sitemap'te yeni görünen URL'ler (ilk 14 günde 3 kez)         |
| P3      | Tıklamada ilk 50 sayfa (haftada bir)                         |
| P4      | Tıklaması %50'den fazla düşen sayfalar                       |
| P5      | Tarayıcının canonical ya da noindex şüphesi bulduğu sayfalar |
| P6      | Sitemap URL'lerinden rastgele örnek (kapsam tahmini)         |

- Sonuç `GscUrlInspection`'a yazılır (son ve önceki durum): `verdict`, `coverageState`, `indexingState`, `robotsTxtState`, `pageFetchState`, `googleCanonical`, `userCanonical`, `lastCrawlTime`, `crawledAs`, `sitemap[]`, `referringUrls[]` ve `richResultsResult` (öğeler ve sorunlar).
- `mobileUsabilityResult` kullanılmaz; Google bu alanı kaldırdı.
- URL Inspection yalnız Google'daki indekslenmiş sürümü anlatır; canlı test yapmaz.
- **Kapsam tahmini:** Page Indexing raporu API'de yoktur. P6 örneğinden Wilson aralığıyla tahmin yapılır: "~82% (±6%) of your sitemap pages are indexed."

**Sitemap ve robots:**

- `sitemaps.list/get` günlük okunur: `errors`, `warnings`, `isPending`, `lastDownloaded`, `contents[].submitted` (`indexed` alanı artık dolmuyor).
- Kendi okumamız:
  - robots.txt günlük okunur; değişirse fark kaydedilir.
  - Sitemap(ler) günlük okunur: `lastmod`, URL sayısı, sitemap index. Sıkıştırılmış (`.gz`) sitemap'ler açılır.
  - Sitemap'teki URL'lerin durum kodu, yönlendirmesi, noindex'i ve canonical uyumu haftalık olarak tarayıcıyla kontrol edilir.
- **robots ayrıştırma:** Google'ın kurallarına uygun yapılır (en uzun eşleşme, `*` ve `$`; doğrulanmalı); Googlebot ve `*` grupları okunur. Google, 5xx dönen bir robots.txt'yi bir süre "her şey engelli" sayar; bu yüzden robots.txt'nin 5xx dönmesi CRITICAL'dır.

**Site tarayıcı** (SK4, SK5):

- **Tohumlar:** ana sayfa, sitemap URL'leri ve GSC'de gösterim alan sayfalar; iç linklerle genişleme (BFS).
- **Sınırlar:** haftada en çok 500 sayfa (KOBİ; plana göre artar), saniyede 1 istek, sayfa başına 2 MB ve 12 sn, yalnız HTML, koşullu GET (`ETag` / `Last-Modified`).
- **Güvenlik:** `safe-fetch` kullanılır (özel IP engeli; en çok 4 yönlendirme, her adımda yeniden doğrulama). Yalnız GSC'de doğrulanmış site ya da `Project.domain` kapsamındaki URL'ler taranır; Agentelse başkalarının sitesini taramak için kullanılamaz.
- **Etik:** robots.txt'de `AgentelseSiteAudit` ya da `*` grubuna uyulur. UA ve açıklama sayfası (`agentelse.com/bot`) vardır; 429 ya da 503'te geri çekilinir.
- **Sayfa başına çıkarılanlar:** durum kodu, yönlendirme zinciri, son URL, canonical, meta robots ve `X-Robots-Tag`, başlık, meta açıklama, H1/H2'ler, `lang`, hreflang, JSON-LD türleri ve ayrıştırma hataları, Open Graph, kelime sayısı, iç linkler (çapa metniyle), alt metni olmayan görseller, sayfa ağırlığı ve TTFB (yaklaşık), karma içerik, istemci tarafı render şüphesi (çok az metin + ağır JS). Sonuç `SeoPage`'e (son durum + `contentHash` + sorunlar) ve `SeoLink`'e (iç link grafiği) yazılır.
- JavaScript render edilmez (tarayıcı otomasyonu yok). Render şüphesi kendisi bir bulgudur: Google JS'i render eder ama gecikmeyle; AI tarayıcılarının çoğu hiç etmez.

**Gerileme bekçisi** (6 saatte bir; ana sayfa + tıklamada ilk 20 sayfa): durum kodu, `noindex`, canonical, başlık ve robots erişimi kontrol edilir. Kilit sayfada `noindex`, robots engeli, 5xx ya da 404 → CRITICAL. Deploy sonrası en sık görülen felaketi, canlıya yanlışlıkla `noindex` gitmesini, saatler içinde yakalar.

**Core Web Vitals:**

- CrUX API haftalık sorgulanır (API anahtarı; proje başına dakikada 150 sorgu; ücretsiz): origin + ilk 20 URL, PHONE ve DESKTOP. Metrikler LCP, INP, CLS (p75) + FCP ve TTFB.
- CrUX History API ile 25-40 haftalık eğilim alınır.
- Yeterli trafiği olmayan URL için CrUX verisi yoktur; o durumda origin gösterilir.
- PageSpeed Insights API yalnız istek üzerine laboratuvar ölçümü için kullanılır. Google, PSI yanıtından CrUX saha verisini çıkarmayı planladığı için saha verisi her zaman CrUX API'den alınır.

**Google güncellemeleri takvimi:** `SearchUpdate` (ad, tür, başlangıç, bitiş, kaynak bağlantısı) global tablosu, Google Search Status Dashboard'dan beslenir (besleme biçimi doğrulanmalı; yoksa operatör elle girer). Güncellemeler grafiklere not olarak düşer; düşüş bulgularına şu cümle eklenir: "Started during the March 2026 core update rollout."

**Search health puanı** (0-100): İndekslenme 35, Teknik 25, Sitemap/robots 15, CWV 15, Veri/entegrasyon 10. Açık bir CRITICAL puanı en fazla 40'ta tutar.

Kontroller ve eşikler §6.1'de (SH1-SH27), teknik denetim kataloğu §6.3'te (TA1-TA24).

### 3.6 SEO fırsat motoru (SC-F4)

**Yeni dosyalar:** `src/lib/seo/rules/*` (saf, testli), `src/lib/seo/{ctr-curve,intent,clusters,impact}.ts`, `src/server/seo/opportunities/{runner,brand-terms,classify}.ts`.

- **Beklenen CTR eğrisi:** Son 3 ayın marka dışı sorgu×sayfa satırlarından, cihaz başına (mobil/masaüstü), pozisyon kovalarında gösterimle ağırlıklı CTR hesaplanır; eğri monoton azalandır (isotonik regresyon). Bir kovada 500'den az gösterim varsa kamuya açık bir eğriye doğru daraltılır (kaynak doğrulanmalı). Marka sorgularının eğrisi ayrıdır.
- **Marka sınıflaması** (`brand-terms.ts`): Brand Brain adı ve varyantları, alan adı kökü, kurucu ve ürün özel adları (kullanıcı onaylı), yazım hataları için katlanmış eşleşme. Kullanıcı Settings'ten düzenler. Lite LLM terim önerir, kullanıcı onaylar (SK8).
- **Niyet:** Önce kurallar uygulanır (soru kelimeleri, "fiyat/price", "satın al/buy", "near me/yakınımda", şehir adları; marka → navigational). Kalanlar lite LLM ile toplu sınıflanır (çağrı başına 200 sorgu); her sorgu bir kez sınıflanır ve sözlükte saklanır.
- **Konu kümeleri:** aynı sayfalarda birlikte sıralanan sorgular (kendi sayfalarımız üzerinden "SERP örtüşmesi" yaklaşımı) + embedding benzerliği (SK13); küme adını lite LLM verir. Kümeler içerik planının (SC-F7) temelidir.
- Kurallar §6.2'de (SO1-SO16).
- **Önceliklendirme:** `priority = impact × confidence ÷ effort`.
  - `impact`: tahmini aylık ek tıklama. Ör. vurucu mesafede (hedef pozisyonun beklenen CTR'si − bugünkü CTR) × gösterim. GA köprüsü varsa sayfanın organik oturum başına key event oranı ve değeriyle çarpılır (§12).
  - `confidence`: veri hacmi ve kuralın kesinliği.
  - `effort`: eylem türünden gelir (başlık/meta S, iç link S, içerik yenileme M, yeni sayfa L, teknik değişken).
  - UI: "Expected +120 clicks/month (directional)."
- **Bulgu kaydı (`SeoFinding`):** GA'daki `GaFinding` ile aynı yaşam döngüsü; parmak izi kural + konu + dönemdir (tarihli).
- **LLM kullanımı** (her çıktı number-check'ten ve kural kontrolünden geçer):
  - başlık/meta varyantları (uzunluk, anahtar kelime, marka sesi, never-rules, approved claims; tıklama tuzağı yok),
  - içerik yenileme brief'i (sayfanın sıralandığı sorgular ambardan, eksik alt konular web araştırmasıyla),
  - yeni makale brief'i (SEO Manager araştırması),
  - iç link çapa önerileri,
  - JSON-LD (kendi doğrulayıcımızdan geçer).
- **Brand Brain ve fikirler:**
  - Stratejik bulgular tarihli `externalRef` ile `SEO` sinyali olur.
  - İçerik boşluğu, yükselen sorgu ve çürüme bulguları fikir havuzuna kanıtla gider (`source: "search"`, `evidence` ≤ 3).
  - Makale fikirleri `?module=seo&idea=` ile brief'i önceden doldurulmuş SEO kartını açar.
- **Sohbet araçları** (SEO modül sohbetinde ve "Search & SEO" sohbetinde):
  - `get_search_overview`,
  - `query_search_performance` (izinli boyutlar; 16 ay + arşiv),
  - `get_page_seo` (bir URL'nin sorguları, indeks durumu, tarama sorunları, CWV),
  - `inspect_url` (bütçeden düşer; P1),
  - `get_seo_opportunities`.
  - Hepsi salt okunurdur ve `external: true` işaretlidir; sorgu metinleri ve taranan sayfa içeriği güvenilmez veridir.
- **Gölge mod:** `SEO_INSIGHTS=shadow` ile 2 hafta; sahip 30 bulguyu inceler.

### 3.7 Uyarılar, raporlama ve planlama (SC-F5)

**Uyarılar:** Ortak `MonitorAlert` kullanılır (`source = "GSC"` ya da `"SEO"`); yönlendirme GA planı §3.7 ile aynıdır.

- CRITICAL örnekleri: kilit sayfada `noindex`, robots engeli, robots.txt'nin 5xx dönmesi, ana sayfanın indeks dışına düşmesi, marka dışı tıklamada çöküş, erişim kaybı.
- Telegram'a sorgu, URL ya da sayı gitmez; yalnız "uygulamayı aç" çağrısı gider.

**Raporlar:**

| Rapor                  | Zaman                                                             | İçerik                                                                                                                                                                                                                                         | Yüzey                             | Maliyet                   |
| ---------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------- |
| Search pulse           | Kesinleşen gün ambara yazılınca                                   | Dün (kesin) ile olağan gün, açık uyarılar, en büyük değişim                                                                                                                                                                                    | "Search & SEO" sohbeti            | Google 0 (ambar), LLM 0   |
| Haftalık SEO raporu    | Son hafta kesinleşince (tipik olarak Çarşamba 09:00, proje saati) | Tıklama, gösterim, CTR, pozisyon (marka dışı ve marka ayrı; geçen hafta ve geçen yıl), kazanan ve kaybeden sorgular ve sayfalar, yükselen sorgular, indeks ve teknik özet, CWV, açık fırsatlar (en çok 5, etkisiyle), değerlendirilen eylemler | Rapor kartı; Markdown ve yazdırma | Google 0, 1 LLM           |
| Aylık / müşteri raporu | Ayın 4'ü                                                          | Ay ile önceki ay ve YoY, SEO hedefleri, kapsam tahmini, CWV, eylemler ve sonuçları, içerik planının durumu, gelecek ayın planı                                                                                                                 | Rapor kartı + paylaşım            | 0-2 Google çağrısı, 1 LLM |
| İsteğe bağlı analiz    | Sohbette                                                          | Ör. "Why did organic traffic drop?" → teşhis ağacı                                                                                                                                                                                             | Sohbet araçları                   | Google 0 (+ P1), 1 LLM    |

**Teşhis ağacı** (düşüşte; sırayla):

1. Veri ya da entegrasyon sorunu mu?
2. Teknik mi? (indeks kaybı, `noindex`, robots, 5xx, canonical, kaybolan değerli URL'ler; SH27). API'de olmayan iki ekran için kullanıcıdan bakması istenir: Search Console → "Manual actions" ve "Security issues" (§3.4).
3. Bir Google güncellemesiyle çakışıyor mu?
4. Talep mi düştü? (sorguların bütün sayfalardaki gösterimi düştü: mevsim ya da pazar)
5. Sıralama mı düştü? (pozisyon kaybı; hangi sayfalarda)
6. CTR mi düştü? (pozisyon sabit, CTR düştü: SERP özellikleri, AI Overview, rakip snippet)
7. Yamyamlaşma mı? (başka bir kendi sayfamız sorguyu devraldı)

Haftalık rapor kartları sohbette **saklanan kart** olarak yazılır; gönderilen raporun sayıları sonradan değişmez.

**"Search & SEO" sohbeti:** Proje başına sistemin açtığı tek bir Work'tür (`wkseo_<projectId>`, modül `seo`); yalnız ilk kart yazılacağı zaman oluşturulur.

**Planlama:**

- **SEO hedefleri** (`ProjectGoal.metricKey`): `gsc.nonBrandClicks`, `gsc.clicks`, `gsc.top10Queries`, `seo.indexedShare`, `seo.cwvGoodShare`. `currentValue` her gün ambardan yazılır.
- **Tempo ve tahmin:** marka dışı tıklama tahmini; 13+ ay geçmiş varsa YoY mevsimsellik. Yeni içeriğin katkısı ayrı ve yönlü gösterilir.
- **"SEO roadmap" kartı** (aylık): etki/emek sırasıyla ilk 10 eylem, bu ayın içerik planı, teknik borç listesi.

### 3.8 Öneri → uygulama → ölçüm döngüsü (SC-F6)

**Eylem türleri ve değerlendirme pencereleri:**

| Tür             | Ne                                                                           | Doğrulama (otomatik)                                                          | Pencere   | Ölçüt                                                       |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------- | ----------------------------------------------------------- |
| TITLE_META      | Başlık ve meta açıklama                                                      | Tarayıcı yeni başlığı görür                                                   | 28 gün    | Pozisyona göre düzeltilmiş CTR (gerçek / beklenen), tıklama |
| CONTENT_REFRESH | Mevcut sayfanın yenilenmesi                                                  | `contentHash` değişti + URL Inspection'da `lastCrawlTime` değişiklikten sonra | 56 gün    | Tıklama, gösterim, sorgu sayısı, pozisyon                   |
| NEW_CONTENT     | Yeni sayfa ya da makale                                                      | Sitemap'te ve canlıda görünür; indekste                                       | 90 gün    | Gösterim, tıklama, hedef sorguda pozisyon                   |
| INTERNAL_LINKS  | İç link ekleme                                                               | Tarayıcı linkleri görür                                                       | 42 gün    | Hedef sayfanın gösterimi ve pozisyonu                       |
| CONSOLIDATE     | Yamyamlaşan sayfaları birleştirme / canonical / 301                          | Yönlendirme ya da canonical canlıda                                           | 56 gün    | Sorgu kümesinin toplam tıklaması, oynaklık                  |
| TECH_FIX        | `noindex`, canonical, robots, 4xx/5xx, yönlendirme, hreflang                 | Tarayıcı + URL Inspection                                                     | 14-28 gün | İndeks durumu, ilgili sayfaların gösterimi                  |
| SCHEMA          | Yapılandırılmış veri                                                         | JSON-LD canlıda ve geçerli; URL Inspection `richResultsResult`                | 28 gün    | Arama görünümü gösterimleri, CTR                            |
| CWV_FIX         | Hız ve kararlılık                                                            | CrUX (28 günlük kayan pencere)                                                | 56 gün    | p75 LCP / INP / CLS                                         |
| SITEMAP_FIX     | Sitemap dosyasının düzeltilmesi (kullanıcı ya da CMS); Google'a gönderim yok | Kendi okumamız + `sitemaps.get` (salt okunur)                                 | 14 gün    | Hata sayısı, yeni URL'lerin indekse girişi                  |

**Yaşam döngüsü:** `PROPOSED → ACCEPTED → APPLIED → VERIFIED → EVALUATING → WORKED | DIDNT | INCONCLUSIVE`.

- APPLIED: kullanıcı "Done" der ya da SC-F8'de CMS yazar.
- VERIFIED: otomatik. Doğrulanamayan bir "Done" 14 gün sonra kullanıcıya sorulur: "We can't see the new title on the live page yet."

**Değerlendirme yöntemi** (ayrıntı §6.4):

- Öncesi/sonrası pencereler karşılaştırılır; değişiklikten sonraki ilk 7 gün hariç tutulur.
- Kontrol grubu: aynı sayfa grubundan, aynı dönemde değişmemiş, benzer trafikli sayfalar; fark-içinde-fark uygulanır.
- CTR, pozisyona göre düzeltilir; 13+ ay geçmiş varsa YoY eklenir.
- Dönemle çakışan bir Google güncellemesi varsa sonuç en fazla INCONCLUSIVE olabilir.

**Öğrenmeler:** `BrandLearning` kaydı açılır (`sourceType = "SEO"`). Örnek: "Question-style titles raised position-adjusted CTR by 18% on service pages (n=5, directional)." Fikir motoru ve SEO Manager istemleri bu öğrenmeleri okur.

**SEO Manager genişlemesi:**

- **"Refresh a page":** bir URL'den başlar. Tarayıcı mevcut içeriği okur; sayfanın sıralandığı sorgular (ambar) ve eksik alt konular (web araştırması) bir yenileme planına dönüşür (URL korunur). Ardından makale → Review (9 on-page denetimi + mevcut sürümle fark) → Deliver; bir `SeoAction(CONTENT_REFRESH)` açılır.
- **"Fix the snippet":** SERP önizlemesiyle 3 başlık + 3 meta varyantı; bir `SeoAction(TITLE_META)` açılır.
- **Fırsattan açılış:** bulgudaki "Fix this" düğmesi, brief'i doldurulmuş kartı açar.
- Uzun işler arka planda ve SSE ile canlı çalışır (`driveJobInline` deseni); "Write another" aynı sohbette kalır.

**SC-F6'da kaydedilen sapmalar** (ayrıntı [search-actions.md](search-actions.md)):

- Haftalık ambar serisi ve hafta+sayfa bootstrap'i (günler üzerinden değil: W1 sayfa metriğini yalnız PT haftası olarak tutar ve değerlendirmenin Google bütçesi 0'dır).
- Kalıcı ölçüm çapası (`measureFrom`): ölçüme geçerken her yazıcı bir kez yazar, değerlendirici olduğu gibi okur.
- Örtüşme penceresi `[çapa − 28 gün, son pencerenin sonu]`, PT günleriyle karşılaştırılır.
- Kontrol yoksa YoY düzeltmeli PRE_POST.
- Tür başına metrik sadeleştirmeleri (CONTENT_REFRESH'te sorgu sayısı ve konum yok; CONSOLIDATE sayfa tabanlı, oynaklık yok; SCHEMA için CTR_adj; SITEMAP_FIX'te yeni indekslenen URL yok).
- Sağlık sorunu düzeltmeleri uyarının çözülmesiyle ölçülür.
- Yalnız WORKED, rakamsız öğrenmeler.
- Disconnect GSC'ye bağlı `SeoAction` satırlarını ve SEO öğrenmelerini siler, SEO kartlarını temizler (ev kuralı §4'ün "yalnız Gsc*" cümlesini geçersiz kılar).

### 3.9 Uygulama katmanı ve AI arama görünürlüğü (SC-F8)

- **CMS entegrasyonları** (her biri ayrı bir entegrasyon ve ayrı bir plan):
  - Sıra: WordPress (REST API + Application Password; başlık/meta alanları Yoast ya da Rank Math'in REST desteğine bağlı, doğrulanmalı), sonra Shopify (Admin API, SEO alanları) ve Webflow (CMS API).
  - Yetenek: `WEBSITE_UPDATE`.
  - Varsayılan davranış "taslak oluştur"dur. Canlı değişiklik OWNER/ADMIN onayıyla yapılır; önce/sonra anlık görüntüsü alınır; tek dokunuşla geri alınabilir; hız sınırı vardır (günde en çok N değişiklik).
- **Sitemap gönderimi yok (SK10):** Agentelse Google'a sitemap göndermez ve sitemap silmez; `webmasters` yazma izni istenmez. Sitemap sorunları rapor ve rehberle kullanıcıya bırakılır; bir CMS bağlıysa sitemap dosyasını düzeltmek (gönderim değil) CMS üzerinden onaylı bir eylem olabilir.
- **IndexNow:** Bing ve Yandex için isteğe bağlı (Google desteklemiyor).
- **AI arama görünürlüğü (GEO/AEO) denetimi:**
  - robots.txt'de AI tarayıcılarının (Google-Extended, GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot…) durumu. Karar kullanıcınındır; Agentelse yalnız bilgi verir.
  - `llms.txt` varlığı; Organization / LocalBusiness şeması ve `sameAs` tutarlılığı; soru-cevap biçimli içerik blokları; varlık (entity) tutarlılığı.
  - Ölçüm: GA köprüsünden AI asistan trafiği (GA planı AN7); Search Console'daki Gen-AI raporu API'ye gelirse onun gösterimleri.
- Google Business Profile (yerel SEO) ayrı ve gelecekteki bir entegrasyondur. Yerel niyetli sorgular (SO11) şimdilik yerel sayfa önerisine döner.

### 3.10 Arayüz yüzeyleri

| Yüzey                                                                                                                                | Ne gösterir                                                                                                                                           | Eylemler                                                                              | Faz           |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------- |
| Integrations → Search Console                                                                                                        | Durum, "Connected as", site kartı (mülk türü, yetki), alan adı uyarısı, "Final data through …", Search health puanı, URL Inspection bütçe kullanımı   | Reconnect, Use existing connection, Change site, Refresh, Disconnect, Delete data now | SC-F1 – SC-F3 |
| "Search" sayfası (`/projects/[projectId]/arama`; rota adı mevcut düzene uyar. Sol menüde Explore altından ve Brand kartından açılır) | KPI başlığı (marka dışı / marka / toplam), güncelleme notlu trend, sorgular, sayfalar, fırsatlar, indeks ve teknik sağlık, CWV, eylemler ve sonuçları | Dönem ön ayarları + tek tarih seçici; Fix this; Accept / Dismiss / Done; Inspect URL  | SC-F2 – SC-F6 |
| Brand sekmesi "Search" kartı                                                                                                         | Son 28 gün marka dışı tıklama, eğilim, sağlık noktası                                                                                                 | Open                                                                                  | SC-F2         |
| Analytics modül kartı                                                                                                                | GSC bölümü: marka ayrımı, sorgular ve sayfalar                                                                                                        | —                                                                                     | SC-F2         |
| SEO Manager kartı                                                                                                                    | Quick wins (CTR eğrili), "Refresh a page", "Fix the snippet", fırsattan açılış, doğrulama durumu                                                      | —                                                                                     | SC-F4 / SC-F6 |
| "Search & SEO" sohbeti                                                                                                               | Nabız, raporlar, uyarılar, roadmap                                                                                                                    | Soru sorma, Accept                                                                    | SC-F5         |
| Fikir panosu                                                                                                                         | Kanıtlı SEO fikirleri ("From your search data")                                                                                                       | Make this article                                                                     | SC-F4         |
| Works "Needs attention"                                                                                                              | Kritik SEO uyarıları                                                                                                                                  | Open / Mute                                                                           | SC-F3         |
| Settings                                                                                                                             | Marka terimleri, arşiv, tarama (aç/kapat, sayfa sınırı), URL Inspection bütçesi, rapor günleri                                                        | —                                                                                     | SC-F3 – SC-F5 |
| /health (operatör)                                                                                                                   | GSC hata oranı, kotalar, inceleme kullanımı, tarama sayaçları (yalnız sayaçlar)                                                                       | —                                                                                     | SC-F2         |

Platform mülkleri (Instagram/TikTok/X/YouTube) API'ye gelirse sosyal kanalların arama görünürlüğü ayrı bir kartta gösterilir (SK17).

### 3.11 Güvenlik, gizlilik ve uyumluluk

- GA planı §3.11'deki her madde burada da geçerlidir: Limited Use beyanı, gizlilik metni, AI işleme, veri azaltımı, şifreleme, kiracı izolasyonu, denetim.
- **Kalıcı arşiv beyanı** (SK3; hukuki görüş doğrulanmalı): "Agentelse keeps your Search Console history, including data older than the 16 months Google keeps. You can delete it anytime."
- **Tarayıcı:** yalnız doğrulanmış alan adları taranır; SSRF korumaları, robots.txt'ye uyum, hız sınırı, kimliği açık UA ve bot sayfası.
- **Prompt injection:** Taranan sayfa içeriği ve sorgu metinleri en riskli girdidir; üçüncü kişiler sayfaya ya da yorum alanına talimat yazabilir. Bu yüzden:
  - içerik LLM'e yalnız "data" bloğunda, kırpılmış ve temizlenmiş gider,
  - araçlar `external: true` işaretlidir,
  - LLM çıktısı (başlık, meta, şema) kural kontrolünden ve JSON-LD doğrulayıcısından geçer.
- **Rakip siteler:** Tarayıcı rakip sitelere gitmez. Rakip ve SERP bilgisi yalnız mevcut web araştırma aracından, kaynaklarıyla gelir.

---

## 4. Veri modeli

**Adlandırma ve alan türleri:** GSC tabloları `Gsc*`, sitenin kendisinden gelen denetim tabloları `Seo*` önekini taşır. Ortak tablolar (`GoogleGrant`, `IntegrationCredential.grantId`, `MonitorAlert`, `SystemHeartbeat`) GA planı §4'te tanımlıdır. `MonitorAlert` kavramsal addır: fiziksel tablo Meta uygulamasının kurduğu `AdsAlert`'tir (+ `source` kolonu, GK8); Search Console uyarılarının `dedupeKey`'i `gsc:` ya da `seo:` ile başlar. `kind`, `status`, `health` gibi alanlar String'dir (TS union); yeni bir değer migration gerektirmez.

| Model (faz)                                  | Amaç                                               | Ana alanlar                                                                                                                                                                                                                                                                                                                                                                                                               | Benzersiz / indeks                                                   | Tahmini hacim                   | Saklama                 |
| -------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------- | ----------------------- |
| `GscSiteLink` (SC-F2)                        | Proje ↔ GSC sitesi; sağlık, kota ve senkron durumu | `workspaceId, projectId, credentialId, grantId, siteUrl, propertyType (DOMAIN / URL_PREFIX), permissionLevel, domainMatch, brandTerms (Json), health, healthReason, healthScore, rateLimitedUntil, loadLimitedUntil, inspectionsToday (Json: PT günü + sayı), syncLeaseUntil, syncLeaseOwner, consecutiveFailures, lastFinalDate, lastFreshAt, backfill (Json), archive (Boolean, varsayılan true), crawlSettings (Json)` | `@@unique([projectId, siteUrl])`                                     | Proje başına 1                  | Disconnect + 30 gün     |
| `GscDailyTotal` (SC-F2)                      | Tür başına günlük toplam                           | `linkId, projectId, date (PT günü), searchType, clicks, impressions, ctr, position, fresh, fetchedAt`                                                                                                                                                                                                                                                                                                                     | `@@unique([linkId, date, searchType])`                               | Site başına yılda ~400-2.000    | Süresiz (SK3)           |
| `GscDailySlice` (SC-F2)                      | Günlük kırılımlar (ülke, cihaz, görünüm)           | `linkId, projectId, kind, date, rows (Json), fresh`                                                                                                                                                                                                                                                                                                                                                                       | `@@unique([linkId, kind, date])`                                     | Yılda ~1.100                    | 16 ay; sonra aylık özet |
| `GscQuery` (SC-F2)                           | Sorgu sözlüğü                                      | `linkId, text, textHash, isBrand, intent, language, clusterId, firstSeenWeek, lastSeenWeek`                                                                                                                                                                                                                                                                                                                               | `@@unique([linkId, textHash])`                                       | KOBİ'de 1-20 bin                | Bağlantı yaşadıkça      |
| `GscPage` (SC-F2)                            | Sayfa sözlüğü                                      | `linkId, url, urlHash, path, pageGroup, firstSeenWeek, lastSeenWeek`                                                                                                                                                                                                                                                                                                                                                      | `@@unique([linkId, urlHash])`                                        | 50-5.000                        | Bağlantı yaşadıkça      |
| `GscWeeklyQuery` / `GscWeeklyPage` (SC-F2)   | Haftalık özet                                      | `linkId, weekStart, queryId / pageId, clicks, impressions, positionWeighted`                                                                                                                                                                                                                                                                                                                                              | `@@unique([linkId, weekStart, queryId])` (sayfa için `pageId`)       | KOBİ'de haftada 200-5.000 satır | 36 ay; sonra aylık      |
| `GscWeeklyQueryPage` (SC-F2)                 | Haftalık sorgu×sayfa (ilk 25.000)                  | `linkId, weekStart, queryId, pageId, clicks, impressions, positionWeighted`                                                                                                                                                                                                                                                                                                                                               | `@@unique([linkId, weekStart, queryId, pageId])`                     | Haftada 300-25.000              | 16 ay                   |
| `GscMonthlyQuery` / `GscMonthlyPage` (SC-F2) | Aylık arşiv                                        | Haftalıkla aynı alanlar, `month` ile                                                                                                                                                                                                                                                                                                                                                                                      | `@@unique([linkId, month, queryId])` (sayfa için `pageId`)           | Ayda 500-20.000                 | Süresiz (SK3)           |
| `GscUrlInspection` (SC-F3)                   | URL'nin son ve önceki indeks durumu                | `linkId, pageId, inspectedAt, verdict, coverageState, indexingState, robotsTxtState, pageFetchState, googleCanonical, userCanonical, lastCrawlTime, crawledAs, richResults (Json), previous (Json), reason (P1-P6)`                                                                                                                                                                                                       | `@@unique([linkId, pageId])`, `@@index([linkId, inspectedAt])`       | Sayfa başına 1                  | Bağlantı yaşadıkça      |
| `GscSitemap` (SC-F3)                         | Sitemap durumu                                     | `linkId, path, type, isIndex, isPending, lastSubmitted, lastDownloaded, errors, warnings, submittedCount, ownFetch (Json: durum, URL sayısı, sorunlar), checkedAt`                                                                                                                                                                                                                                                        | `@@unique([linkId, path])`                                           | Site başına 1-20                | Bağlantı yaşadıkça      |
| `SeoCrawl` (SC-F3)                           | Tarama koşusu                                      | `projectId, linkId?, kind (FULL / REGRESSION), startedAt, finishedAt, pagesFetched, status, robotsHash, stats (Json)`                                                                                                                                                                                                                                                                                                     | `@@index([projectId, startedAt])`                                    | Haftada ~30                     | 90 gün                  |
| `SeoPage` (SC-F3)                            | Sayfanın son taranmış hali                         | `projectId, url, urlHash, status, finalUrl, redirectChain (Json), canonical, robotsMeta, xRobotsTag, title, metaDescription, h1, headings (Json), lang, hreflang (Json), schemaTypes[], schemaErrors (Json), wordCount, inlinks, outlinks, imagesNoAlt, bytes, ttfbMs, renderRisk, contentHash, issues (Json), lastCrawledAt, firstSeenAt, goneAt`                                                                        | `@@unique([projectId, urlHash])`                                     | 50-5.000                        | `goneAt` + 90 gün       |
| `SeoLink` (SC-F3)                            | İç link grafiği                                    | `projectId, fromPageId, toUrlHash, anchor, nofollow`                                                                                                                                                                                                                                                                                                                                                                      | `@@index([projectId, toUrlHash])`                                    | Sayfa başına 20-200             | Yalnız son tarama       |
| `SeoCwv` (SC-F3)                             | CrUX ölçümleri                                     | `projectId, scope (ORIGIN / URL), target, formFactor, collectionPeriod, lcpP75, inpP75, clsP75, fcpP75, ttfbP75, histogram (Json)`                                                                                                                                                                                                                                                                                        | `@@unique([projectId, scope, target, formFactor, collectionPeriod])` | Haftada ~40                     | 24 ay                   |
| `SearchUpdate` (SC-F3, global)               | Google güncellemeleri takvimi                      | `name, kind, startedAt, endedAt, url`                                                                                                                                                                                                                                                                                                                                                                                     | `@@unique([name])`                                                   | Yılda ~10                       | Süresiz                 |
| `SeoFinding` (SC-F4)                         | Fırsat ya da sorun bulgusu                         | `GaFinding` ile aynı alanlar + `pageId?, queryId?, clusterId?`                                                                                                                                                                                                                                                                                                                                                            | `@@unique([fingerprint])`, `@@index([projectId, status])`            | Ayda 10-50                      | 24 ay                   |
| `SeoCluster` (SC-F4)                         | Konu kümesi                                        | `linkId, name, pillarPageId?, queryCount, impressions28d, status`                                                                                                                                                                                                                                                                                                                                                         | `@@index([linkId])`                                                  | 10-200                          | Bağlantı yaşadıkça      |
| `SeoAction` (SC-F6)                          | Eylem ve sonucu                                    | Taslak aşağıda                                                                                                                                                                                                                                                                                                                                                                                                            | `@@index([projectId, status])`                                       | Ayda 5-30                       | 36 ay                   |

Kısa şema taslağı:

```prisma
model SeoAction {
  id             String    @id @default(cuid())
  workspaceId    String
  projectId      String
  linkId         String?   // GscSiteLink; GSC bağlı değilse tarayıcı ve CrUX ile yine çalışır
  findingId      String?
  kind           String    // TITLE_META | CONTENT_REFRESH | NEW_CONTENT | INTERNAL_LINKS | CONSOLIDATE | TECH_FIX | SCHEMA | CWV_FIX | SITEMAP_FIX
  pageId         String?
  targetUrl      String?
  targetQueries  String[]  // sözlük kimlikleri
  proposal       Json      // önerilen başlık/meta/brief/şema; önce-sonra
  status         String    // PROPOSED | ACCEPTED | APPLIED | VERIFIED | EVALUATING | WORKED | DIDNT | INCONCLUSIVE | DISMISSED | EXPIRED
  appliedVia     String?   // USER | CMS
  appliedAt      DateTime?
  verifiedAt     DateTime?
  verification   Json?     // tarayıcı ve URL Inspection kanıtı
  windowDays     Int
  evaluateAfter  DateTime?
  evaluation     Json?     // öncesi/sonrası, kontrol grubu, etki, aralık, güncelleme çakışması
  outcome        String?
  creativeId     String?   // SEO Manager makalesi (seo.article)
  approvalId     String?   // SC-F8 CMS yazmaları
  createdByUserId String?
  createdAt      DateTime  @default(now())
  @@index([projectId, status])
  @@index([status, evaluateAfter])
}
```

**Mevcut modellerle ilişki:**

- `GscSiteLink.credentialId` → `IntegrationCredential` (provider `google_search_console`); `grantId` → `GoogleGrant`.
- `SeoAction.creativeId` → `seo.article` Creative (SEO Manager'ın takvim kaydı); `SeoFinding.signalId` → `Signal`; fikirler → fikir havuzu.
- `SeoPage` ve `SeoCwv` GSC bağlantısına bağlı değildir (projeye bağlıdır). Tarayıcı ve CWV, GSC bağlı olmasa da `Project.domain` doğrulanmışsa çalışabilir. Search Console'un Disconnect'i yalnız `Gsc*` tablolarını siler.
- `IntegrationCredential.metadata` içindeki GSC alanları (`searchConsoleSites`, `selectedSearchConsoleSite`, tarama defteri) geçiş boyunca okunur; SC-F2'den sonra yalnız seçim alanları yazılır.
- FK'ler proje silinince cascade eder.

**Hacim notu:** Tipik bir KOBİ sitesinde haftada ~300 sorgu, ~50 sayfa ve ~500 sorgu×sayfa satırı olur; 70 haftada ~60 bin satır eder. 100 sitede ~6 milyon satır ve indekslerle ~1-2 GB tutar. Sınırlar plana göre ayarlanır (ilk N, saklama).

**Migration stratejisi:** GA planı §4 ile aynıdır (faz başına yeni klasör, yalnız ekleme, tek kullanımlık yerel Postgres'te `migrate diff`, var olan migration'a asla dokunulmaz).

---

## 5. İşler, zamanlama ve kota bütçesi

| İş                                                       | Sıklık                                                                             | Tetikleyici      | Kilit                                 | Google / site bütçesi                                                       | Başarısızlıkta                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------- | ------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `google-grant-health` (ortak)                            | Günlük + bağlanırken                                                               | Ajans tick adımı | `GoogleGrant` CAS                     | Grant başına 1 refresh + 1 `tokeninfo` + 1 `sites.list`                     | AUTH → EXPIRED + uyarı                                                                   |
| `gsc-sync`                                               | Her tick'te vadesi gelen en çok 3 site                                             | Ajans tick adımı | `GscSiteLink` kilidi (5 dk, CAS)      | §5.1                                                                        | Geri çekilme (5 dk → 6 sa); RATE/LOAD → bekle; AUTH → dur; 3 ardışık hata → SYNC_FAILING |
| ├ daily                                                  | Günde 2 kez (PT 06:00 ve 18:00): toplamlar (kesin + taze), kırılımlar, sitemap'ler |                  |                                       | ~10 istek                                                                   | Sonraki deneme                                                                           |
| ├ weekly                                                 | `lastFinalDate` hafta sonunu geçince (tipik olarak Çarşamba)                       |                  |                                       | KOBİ'de ~3-10 istek                                                         | Sonraki tick                                                                             |
| ├ monthly                                                | `lastFinalDate` ay sonunu geçince                                                  |                  |                                       | ~2-6 istek                                                                  |                                                                                          |
| ├ hourly                                                 | Yalnız erken uyarı (6 saatte bir) ve sayfa açıkken                                 |                  |                                       | 1 istek                                                                     |                                                                                          |
| └ backfill                                               | Bağlanınca, parça parça                                                            |                  |                                       | KOBİ'de 250-400 istek                                                       | Kaldığı yerden                                                                           |
| `gsc-inspect`                                            | Günlük bütçe, güne yayılmış (dakikada ≤ 10)                                        | Ajans tick adımı | Site + PT günü sayacı                 | Varsayılan 200/gün                                                          | INSPECTION_QUOTA → ertesi PT günü                                                        |
| `seo-crawl`                                              | Tam tarama haftada bir (sitenin gece saatlerinde); gerileme bekçisi 6 saatte bir   | Ajans tick adımı | `SeoCrawl` CAS (site başına tek koşu) | Müşteri sitesine ≤ 1 istek/sn; haftada ≤ 500 sayfa + günde ~84 bekçi isteği | Kaldığı yerden; engellenirse "unknown"                                                   |
| `seo-cwv`                                                | Haftalık                                                                           | Ajans tick adımı | Proje + hafta                         | ~40 CrUX sorgusu (proje başına dakikada 150 sınırı)                         | Sonraki gün                                                                              |
| `seo-health`                                             | Senkron ve taramadan sonra                                                         | Ajans tick adımı | Proje + gün                           | 0                                                                           | Uyarı tekilleşir                                                                         |
| `seo-opportunities`                                      | Haftalık (haftalık özetlerden sonra) + günlük toplam anomalisi                     | Ajans tick adımı | Proje + dönem                         | 0 (+ lite LLM sınıflama)                                                    | Sonraki tick                                                                             |
| `seo-action-verify`                                      | Günlük                                                                             | Ajans tick adımı | Eylem CAS                             | Tarayıcı + inceleme bütçesinden                                             | 14 gün sonra kullanıcıya sorulur                                                         |
| `seo-action-evaluate`                                    | Günlük (vadesi gelenler)                                                           | Ajans tick adımı | Eylem CAS                             | 0                                                                           | —                                                                                        |
| `seo-pulse` / `seo-weekly-report` / `seo-monthly-report` | §3.7                                                                               | Ajans tick adımı | Proje + gün/hafta/ay                  | 0 (+1 LLM)                                                                  | Sonraki tick                                                                             |
| `search-updates-sync` (global)                           | Günlük                                                                             | Ajans tick adımı | Global kilit                          | 1 HTTP isteği                                                               | Operatör elle girer                                                                      |
| `seo-retention`                                          | Günlük 03:00 UTC                                                                   | Ajans tick adımı | Global kilit                          | 0                                                                           | —                                                                                        |

Adımlar `registerAgencyTickStep` ile kaydedilir. `legacy-loop.ts`'teki listelerin ve `FOCUS_DISABLED_TICK_STEPS`'in dışında kalırlar; `AGENCY_FOCUS` ayarı sağlık ve senkron adımlarını kapatmaz. Nabız anahtarları: `gsc.sync`, `seo.crawl`.

### 5.1 Kota bütçesi

**Google sınırları:**

| Sınır                                               | Değer                                                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Search Analytics: site başına                       | Dakikada 1.200 sorgu                                                                                      |
| Search Analytics: kullanıcı başına                  | Dakikada 1.200 sorgu                                                                                      |
| Search Analytics: proje başına                      | Dakikada 40.000, günde 30.000.000 sorgu                                                                   |
| Search Analytics "load"                             | 10 dakikalık kısa dönem + 1 günlük uzun dönem; sorgu×sayfa gruplaması ve uzun aralıklar en pahalı olanlar |
| URL Inspection: site başına                         | Günde 2.000, dakikada 600                                                                                 |
| URL Inspection: proje başına                        | Günde 10.000.000, dakikada 15.000                                                                         |
| Diğer kaynaklar (sites, sitemaps): kullanıcı başına | Saniyede 20, dakikada 200                                                                                 |
| CrUX API (CrUX + History ortak)                     | Proje başına dakikada 150; ücretsiz, artırılamaz                                                          |

**Bir sitenin günlük kullanımı (bizim tasarım):**

| Kalem                                     | İstek/gün                                 |
| ----------------------------------------- | ----------------------------------------- |
| Toplamlar + kırılımlar (günde 2 kez)      | ~10-14                                    |
| Haftalık ve aylık özetler (güne bölünmüş) | ~2-3                                      |
| Sitemap'ler ve sites                      | ~2-4                                      |
| Saatlik erken uyarı                       | 4                                         |
| Sohbet ve "Refresh" (P1)                  | ≤ 20                                      |
| URL Inspection                            | ≤ 200 (bütçe)                             |
| **Toplam**                                | **~40 Search Analytics + ≤ 200 inceleme** |

- Bu, site başına dakikalık sınırın ve günlük inceleme sınırının çok altındadır.
- **Ajans senaryosu (100 site):** günde ~4.000 Search Analytics isteği ve ≤ 20.000 inceleme; proje sınırları (günde 30 milyon / 10 milyon) sorun değildir. CrUX'ta haftada ~4.000 sorgu, dakikada 150 sınırına göre güne yayılır.
- **Müşteri sitesine yük:** tam tarama haftada en çok 500 sayfa, saniyede 1 istek, koşullu GET ile çoğu yanıt 304 döner.

---

## 6. Profesyonel oyun kitabı

KOBİ ölçeğine göre ayarlanmıştır: ayda 1.000-200.000 gösterim, 20-2.000 sayfa, çoğunlukla yerel ya da hizmet odaklı siteler. Taban, sitenin kendi geçmişidir; sektör benchmark'ı yalnız CTR eğrisinin yedeğinde kullanılır.

### 6.1 Arama sağlığı kontrolleri (SC-F3)

| Kod  | Kontrol                                           | Kaynak               | Eşik                                                                                                                                                                                                                                                                            | Önem                                                          |
| ---- | ------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| SH1  | Senkron ve veri tazeliği                          | INTEGRATION          | Son kesin gün 5 günden eski (Google gecikmesi hariç) ya da senkron 36 saattir başarısız                                                                                                                                                                                         | WARN                                                          |
| SH2  | Arama çöküşü                                      | DATA                 | Marka dışı web tıklaması, haftanın aynı günü medyanının %50'sinin altında, 2 kesin gün üst üste (taban ≥ 20 tıklama/gün) → CRITICAL; %50-75 → WARN. Erken uyarı: saatlik veride son 24 saat, aynı saatlerin tabanının %20'sinin altında → WARN (tarayıcı bekçisiyle doğrulanır) | CRITICAL / WARN                                               |
| SH3  | Kilit sayfada `noindex`                           | CRAWL (6 sa)         | Ana sayfada ya da ilk 20 sayfada meta robots veya `X-Robots-Tag` noindex                                                                                                                                                                                                        | CRITICAL                                                      |
| SH4  | robots.txt engeli                                 | CRAWL                | Googlebot ya da `*` için `Disallow: /`; kilit sayfa veya dizin, sitemap ya da CSS/JS engeli; robots.txt'nin 5xx dönmesi. (404 sorun değildir: her şey serbest sayılır)                                                                                                          | CRITICAL                                                      |
| SH5  | Kilit sayfa durum kodu                            | CRAWL                | Kilit sayfada 5xx, 404 ya da 410; yönlendirme döngüsü                                                                                                                                                                                                                           | CRITICAL                                                      |
| SH6  | Canonical sapması                                 | INSPECTION + CRAWL   | Google'ın canonical'ı kullanıcınınkinden farklı (kilit sayfa) → WARN; canonical başka bir alan adına → CRITICAL                                                                                                                                                                 | WARN / CRITICAL                                               |
| SH7  | İndeks kaybı                                      | INSPECTION           | Kilit sayfa PASS → FAIL ya da NEUTRAL                                                                                                                                                                                                                                           | CRITICAL                                                      |
| SH8  | Yeni sayfalar indekslenmiyor                      | INSPECTION           | Sitemap'e 14 günden önce giren URL'lerin %30'undan fazlası hâlâ indeks dışı                                                                                                                                                                                                     | WARN                                                          |
| SH9  | Kapsam düşüşü                                     | INSPECTION örneklemi | Tahmini indeks payı %70'in altında ya da 4 haftada ≥ 10 puan düşüş (aralıklar örtüşmüyorsa)                                                                                                                                                                                     | WARN                                                          |
| SH10 | "Crawled - currently not indexed" artışı          | INSPECTION           | Örneklemde bu durumun payı 4 haftada ≥ 2 katına çıktı (içerik kalitesi sinyali)                                                                                                                                                                                                 | WARN                                                          |
| SH11 | Sitemap hataları                                  | GSC + kendi okumamız | `errors > 0`, `isPending` > 7 gün, `lastDownloaded` > 14 gün, sitemap 404/5xx ya da hiç sitemap yok                                                                                                                                                                             | WARN                                                          |
| SH12 | Sitemap hijyeni                                   | CRAWL                | Sitemap URL'lerinin %5'inden fazlası yönlendirme, 4xx, noindex ya da başka bir canonical                                                                                                                                                                                        | WARN                                                          |
| SH13 | Tarama tazeliği                                   | INSPECTION           | Kilit sayfaların `lastCrawlTime` değeri 60 günden eski                                                                                                                                                                                                                          | INFO                                                          |
| SH14 | Yapılandırılmış veri hataları                     | INSPECTION + CRAWL   | Kilit sayfada `richResultsResult` hatası ya da JSON-LD ayrıştırma hatası                                                                                                                                                                                                        | WARN                                                          |
| SH15 | Core Web Vitals                                   | CrUX                 | Origin p75: LCP > 4 sn, INP > 500 ms ya da CLS > 0,25 → WARN; "needs improvement" → INFO; 4 haftada kötüleşme → WARN                                                                                                                                                            | WARN / INFO                                                   |
| SH16 | HTTPS ve karma içerik                             | CRAWL                | HTTP sayfa, karma içerik, HTTPS'e yönlenmeyen HTTP                                                                                                                                                                                                                              | WARN                                                          |
| SH17 | Yönlendirme zinciri                               | CRAWL                | İç linklerde 2 adımdan uzun zincir ya da döngü                                                                                                                                                                                                                                  | WARN                                                          |
| SH18 | Kırık iç link                                     | CRAWL                | 4xx/5xx'e giden iç linkler (sayı ve kaynak sayfalar)                                                                                                                                                                                                                            | WARN                                                          |
| SH19 | Yetim sayfa                                       | CRAWL + GSC          | Gösterim alan ya da sitemap'te olan ama hiç iç link almayan sayfa                                                                                                                                                                                                               | INFO                                                          |
| SH20 | Başlık ve meta sorunları                          | CRAWL                | İndekslenebilir sayfada eksik ya da çift başlık, eksik meta açıklama, çok uzun ya da kısa başlık                                                                                                                                                                                | INFO                                                          |
| SH21 | hreflang                                          | CRAWL                | Geri dönüş linki yok, geçersiz dil kodu ya da canonical ile çelişki                                                                                                                                                                                                             | WARN                                                          |
| SH22 | İstemci tarafı render riski                       | CRAWL                | Kilit sayfada gövde 150 kelimeden az + ağır JS paketleri                                                                                                                                                                                                                        | WARN                                                          |
| SH23 | Google güncellemesi örtüşmesi                     | UPDATES              | Düşüş bir güncelleme penceresiyle çakışıyor                                                                                                                                                                                                                                     | INFO (açıklama)                                               |
| SH24 | Site ↔ alan adı eşleşmesi                         | ADMIN                | GSC sitesi `Project.domain`'i kapsamıyor ya da `www`/protokol uyuşmazlığı var                                                                                                                                                                                                   | WARN                                                          |
| SH25 | Entegrasyon sağlığı                               | INTEGRATION          | Token, izin, site erişimi (`siteUnverifiedUser`), kota                                                                                                                                                                                                                          | Duruma göre                                                   |
| SH26 | AI tarayıcı erişimi                               | CRAWL                | robots.txt AI tarayıcılarını engelliyor ya da serbest bırakıyor                                                                                                                                                                                                                 | INFO (karar kullanıcının)                                     |
| SH27 | Kaybolan değerli URL'ler (site taşıma / yenileme) | CRAWL + GSC          | Son 90 günde tıklama almış bir URL artık 404/410 dönüyor, ana sayfaya ya da ilgisiz bir sayfaya yönleniyor veya `noindex` olmuş. Ya da tarama bir anda çok sayıda yeni URL ve 3xx görüyor (site taşıma imzası)                                                                  | CRITICAL (kilit sayfa ya da toplam tıklamanın > %10'u) / WARN |

Her kontrolün 3-6 adımlık İngilizce bir düzeltme rehberi vardır (`guides.ts`); rehberler Search Console'daki ilgili ekranın adını verir. SH27'nin rehberi ayrıca hazır bir 301 yönlendirme haritası içerir: değer kaybeden her eski URL, başlık ve içerik benzerliğine göre en yakın yeni sayfayla eşleştirilir. Bu, KOBİ'lerde en sık görülen SEO felaketini (site yenilenirken eski adreslerin kırılması) ilk günden yakalar.

### 6.2 SEO fırsat kuralları (SC-F4)

| Kod  | Kural                        | Koşul / yöntem                                                                                                                                                                                                                     | Asgari veri                         | Çıktı                                                                | Gerekçe                                     |
| ---- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------- | ------------------------------------------- |
| SO1  | Vurucu mesafe                | Marka dışı sorgu×sayfa; ortalama pozisyon 4-20; 28 günde gösterim ≥ max(100, sitenin p75'i); tek baskın sayfa                                                                                                                      | 28 günlük veri                      | Sayfa başına fırsat: hedef sorgular + "Refresh a page" ya da iç link | Az emekle en büyük kazanç genelde burada    |
| SO2  | CTR açığı (snippet)          | Pozisyon ≤ 10; gerçek CTR, pozisyona ve cihaza göre beklenen CTR'nin 0,7 katının altında; gösterim ≥ 500 / 28 gün                                                                                                                  | Kovada yeterli veri                 | "Fix the snippet" + kaybedilen tıklama tahmini                       | Başlık ve meta en ucuz değişiklik           |
| SO3  | İçerik çürümesi              | Sayfa tıklaması son 3 ayda, hem önceki 3 aya hem YoY'ye göre ≥ %30 düşük ve kayıp ≥ max(30 tıklama, %10). Neden sınıflaması: talep / sıralama / CTR (AI Overview olası) / indeks / yamyamlaşma                                     | ≥ 6 ay geçmiş                       | Neden + uygun eylem (yenileme, teknik düzeltme, birleştirme)         | Kayıp çoğu zaman yavaş ve görünmezdir       |
| SO4  | Yamyamlaşma                  | Marka dışı sorguda ≥ 2 sayfa, her biri gösterimin ≥ %10'u; 8 haftada baskın sayfa ≥ 2 kez değişmiş ya da toplam CTR beklenenin altında. Ana sayfa + site bağlantıları istisnadır                                                   | Sorgu başına ≥ 50 gösterim / 28 gün | Birleştir / canonical / iç link / niyete göre ayrıştır               | Sinyal bölünmesi                            |
| SO5  | İçerik boşluğu               | Gösterimi eşiğin üstünde olan marka dışı bir sorgu (ya da küme) için en iyi sayfanın başlık, H1 ve H2'lerinde sorgunun anlamlı kelimeleri yok ya da pozisyon > 20                                                                  | Tarayıcı verisi                     | Yeni sayfa ya da bölüm önerisi → fikir havuzu (kanıtla)              | Talep var, karşılayan sayfa yok             |
| SO6  | Yükselen sorgu               | Son 28 günde ilk kez görülen ya da gösterimi 4 haftada ≥ 3 katına çıkan sorgu veya küme                                                                                                                                            | ≥ 50 gösterim                       | Zamanlı içerik fikri                                                 | Erken davranan kazanır                      |
| SO7  | Kaybedilen sorgu ya da sayfa | Önceki dönemde ≥ 10 tıklama, şimdi 0; sayfa 404 ya da noindex mi                                                                                                                                                                   | —                                   | Teşhis + eylem                                                       | Görünmez kayıplar                           |
| SO8  | İç link fırsatı              | Gösterimi olan ama en fazla 2 iç link alan sayfa; aynı kümedeki güçlü sayfalardan çapalı link önerileri                                                                                                                            | Tarayıcı + küme                     | "Add these 3 links"                                                  | Ucuz ve etkili                              |
| SO9  | Sayfa grubu eğilimi          | Şablon ya da dizin (blog, ürün, hizmet, konum) düzeyinde tıklama ve pozisyon eğilimi                                                                                                                                               | Grup başına ≥ 5 sayfa               | Şablon düzeyinde bulgu                                               | Tek tek sayfalardan daha güçlü sinyal       |
| SO10 | Marka talebi                 | Marka sorgularının gösterimi 8 haftada ≥ %20 değişti                                                                                                                                                                               | ≥ 100 gösterim/hafta                | Pazarlama sinyali (sosyal ve reklam etkisi)                          | Marka bilinirliğinin ölçüsü                 |
| SO11 | Yerel niyet                  | "near me" / "yakınımda", şehir ya da mahalle adı içeren sorgular ve karşılık gelen yerel sayfa yok                                                                                                                                 | ≥ 50 gösterim                       | Yerel sayfa önerisi (kapı sayfası raylarıyla)                        | KOBİ'de en değerli sorgular                 |
| SO12 | Zengin sonuç fırsatı         | Uygun şema türü olan ama işaretlenmemiş sayfa (Organization, LocalBusiness, Product, Review, BreadcrumbList, Article, Video, Event). FAQ ve HowTo zengin sonucu önerilmez (Google kısıtladı); FAQ içeriği AEO için yine yararlıdır | Tarayıcı                            | Doğrulanmış JSON-LD                                                  | Görünüm ve CTR                              |
| SO13 | Uluslararası uyumsuzluk      | Yerelleştirilmiş sayfası olmayan bir ülkeden anlamlı gösterim; dil uyuşmazlığı                                                                                                                                                     | Ülke başına ≥ 500 gösterim          | hreflang ya da yerelleştirme önerisi                                 | Kaçan talep                                 |
| SO14 | Görsel ve video araması      | `image`/`video` türlerinde gösterim; alt metni ya da şeması eksik sayfalar                                                                                                                                                         | ≥ 200 gösterim                      | Alt metin ve video şeması                                            | Ek görünürlük                               |
| SO15 | Yeni içerik performansı      | Yayından 28-90 gün sonra yeni sayfanın gösterimi, sitenin yeni sayfa medyanının altında                                                                                                                                            | ≥ 3 yeni sayfa                      | İndeks, iç link ve hedef kontrolü                                    | Erken müdahale                              |
| SO16 | Teknik sorunun trafik etkisi | TA sorunu olan sayfalar gösterim ve tıklamayla ağırlıklandırılarak sıralanır                                                                                                                                                       | —                                   | Teknik borç listesinin önceliği                                      | Önemsiz sayfadaki sorunla vakit kaybetmemek |

### 6.3 Teknik denetim kataloğu (sayfa düzeyi, SC-F3)

| Kod  | Sorun                                                         | Önem                          | Düzeltme (özet)                                    |
| ---- | ------------------------------------------------------------- | ----------------------------- | -------------------------------------------------- |
| TA1  | Eksik başlık                                                  | WARN                          | Sayfaya özgü başlık yaz                            |
| TA2  | Çift başlık (birden çok sayfada aynı)                         | WARN                          | Her sayfaya ayırt edici başlık                     |
| TA3  | Başlık uzunluğu (çok kısa ya da kesilecek kadar uzun)         | INFO                          | 30-60 karakter civarı                              |
| TA4  | Eksik meta açıklama                                           | INFO                          | Sayfanın vaadini anlatan açıklama                  |
| TA5  | Çift meta açıklama                                            | INFO                          | Sayfaya özgü açıklama                              |
| TA6  | Eksik ya da birden çok H1                                     | INFO                          | Tek ve açık bir H1                                 |
| TA7  | İndekslenmesi gereken sayfada `noindex`                       | CRITICAL (kilit sayfa) / WARN | Etiketi kaldır                                     |
| TA8  | Canonical yok, göreli ya da başka bir sayfaya işaret ediyor   | WARN                          | Kendine işaret eden mutlak canonical               |
| TA9  | 4xx                                                           | WARN                          | Yönlendir ya da linkleri düzelt                    |
| TA10 | 5xx                                                           | CRITICAL (kilit sayfa) / WARN | Sunucu hatasını gider                              |
| TA11 | Yönlendirme zinciri (> 2 adım)                                | WARN                          | Doğrudan son adrese yönlendir                      |
| TA12 | Kırık iç link                                                 | WARN                          | Linki güncelle                                     |
| TA13 | Yetim sayfa                                                   | INFO                          | İlgili sayfalardan link ver                        |
| TA14 | Derinlik > 4 tık                                              | INFO                          | Gezinmeye ya da merkez sayfalara ekle              |
| TA15 | İnce içerik (indekslenebilir, < 200 kelime)                   | INFO                          | Genişlet, birleştir ya da `noindex`                |
| TA16 | Kopya ya da çok benzer içerik                                 | WARN                          | Birleştir ya da farklılaştır, canonical            |
| TA17 | Alt metni olmayan görseller                                   | INFO                          | Açıklayıcı alt metin                               |
| TA18 | Ağır sayfa (> 3 MB) ya da yavaş TTFB (> 1,5 sn)               | WARN                          | Görsel optimizasyonu, önbellek                     |
| TA19 | Karma içerik                                                  | WARN                          | Tüm kaynaklar HTTPS                                |
| TA20 | hreflang hatası                                               | WARN                          | Geri dönüş linkleri ve geçerli kodlar              |
| TA21 | JSON-LD hatası                                                | WARN                          | Şemayı düzelt (Agentelse doğrulanmış sürüm önerir) |
| TA22 | İstemci tarafı render riski                                   | WARN                          | Sunucu tarafı render ya da önceden render          |
| TA23 | Sitemap dışında kalan indekslenebilir sayfa                   | INFO                          | Sitemap'e ekle                                     |
| TA24 | Parametreli URL patlaması (filtre ya da oturum parametreleri) | WARN                          | Canonical, robots kuralı ya da parametre temizliği |

### 6.4 İstatistik ve değerlendirme yöntemi

- **Toplam anomalisi:** GA planı AN1 ile aynı yöntem (haftanın aynı günü, medyan/MAD, sağlam z), yalnız kesin günlerde uygulanır. Taban günde ≥ 20 tıklama değilse haftalık bakılır.
- **Pozisyona göre düzeltilmiş CTR:** `CTR_adj = gerçek CTR / beklenen CTR(pozisyon, cihaz)`. Başlık ve meta değişikliklerinde pozisyon etkisini ayırır.
- **Fark-içinde-fark:** etki = Δ(eylem uygulanan) − Δ(kontrol); log(tıklama) ya da `CTR_adj` üzerinde hesaplanır; günler üzerinden bootstrap (1.000 yeniden örnekleme) ile %90 aralık alınır.
  - **WORKED:** aralık 0'ı dışarıda bırakıyor ve etki ≥ +%10.
  - **DIDNT:** aralık tamamen negatif ya da üst sınır < +%5.
  - **INCONCLUSIVE:** diğer durumlar.
- **Kontrol grubu:** aynı sayfa grubundan, pencerede değişmemiş, öncesi tıklaması ±%50 benzer en az 3 sayfa. Bulunamazsa öncesi/sonrası + YoY düzeltmesi yapılır ve güven en fazla DIRECTIONAL olur.
- **Google güncellemesi** pencereyle çakışıyorsa sonuç en fazla INCONCLUSIVE olur.
- **Çoklu karşılaştırma:** sayfa düzeyi taramalarda Benjamini-Hochberg (FDR %10).
- **Bölünmüş test (SC-F9):** grup başına ≥ 100 benzer sayfası olan şablon sitelerde sayfa gruplarının rastgele ikiye ayrılması; KOBİ'de uygulanmaz.

### 6.5 İçerik kalite rayları

- **Toplu içerik yok:** site başına aylık yeni AI makalesi sınırı vardır (KOBİ varsayılanı 4; Settings'ten en çok 12). Her makale Review adımında insan onayı ister; otomatik yayın yoktur.
- **Kapı sayfası yok:** konum sayfaları yalnız gerçek hizmet bölgeleri için ve sayfaya özgü içerikle önerilir (en az birkaç benzersiz bilgi). Şehir adı değiştirilerek çoğaltılan şablon önerilmez.
- **Site itibarının kötüye kullanımı yok:** üçüncü taraf içeriği barındırma önerisi yapılmaz.
- **E-E-A-T:** yazar bilgisi, kaynaklar ve birinci elden deneyim istenir (kullanıcıdan gerçek örnek ve fotoğraf istenir); yalnız approved claims kullanılır.
- **Uydurma yok:** olgu ve istatistik uydurulmaz; web araştırmasındaki kaynaklar kullanıcıya gösterilir.
- **Anahtar kelime doldurma yok:** on-page denetimi, anahtar kelime yoğunluğu %3'ü aşarsa uyarır.
- **AI beyanı:** markanın politikasına göre isteğe bağlıdır.

---

## 7. Erişim ve Google doğrulaması önkoşulları

| Önkoşul                                                                     | Bugün                          | Gereken                                                                                                                               | Ne zaman      | Beklenen süre |
| --------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- |
| Google Cloud projesi, OAuth istemcisi, yayın durumu, doğrulama, Limited Use | GA planı §7 ile ortak          | `webmasters.readonly` doğrulama başvurusunda yer almalı (GA'nın izniyle aynı başvuru)                                                 | SC-F0 / SC-F1 | GA planı §7   |
| Search Console API                                                          | Kullanılıyor (`webmasters/v3`) | Cloud projesinde etkin olduğu kontrol edilir                                                                                          | SC-F0         | —             |
| Chrome UX Report API anahtarı                                               | Yok                            | Yeni `GOOGLE_API_KEY`; Cloud Console'da yalnız Chrome UX Report API'ye (ve isteğe bağlı PageSpeed Insights API'ye) kısıtlı            | SC-F3         | Anında        |
| Tarayıcı kimliği                                                            | Yok                            | `agentelse.com/bot` açıklama sayfası (UA, amaç, robots.txt ile engelleme, iletişim)                                                   | SC-F3         | —             |
| Alan adı doğrulaması                                                        | Bilinmiyor                     | agentelse.com ve agentelse.ai Search Console'da doğrulanmış olmalı (OAuth doğrulaması da bunu istiyor)                                | SC-F0         | —             |
| Test sitesi                                                                 | —                              | agentelse.com (kendi sitemiz; robots, sitemap ve JSON-LD var) + trafiği olan gerçek bir müşteri ya da ajans sitesi (sahibin onayıyla) | SC-F0 – SC-F2 | —             |
| `webmasters` (yazma) izni                                                   | Yok                            | **İstenmez** (SK10): sitemap gönderimi yapılmaz; entegrasyon her zaman salt okunur                                                    | —             | —             |

**Demo videosu senaryosu (Search Console):** Connectors → Search Console → Google onay ekranı → site seçimi (Domain mülkü önerisi) → Search sayfası (marka dışı tıklama, sorgular, sayfalar, indeks sağlığı) → bir fırsat → "Fix the snippet" → Disconnect ve "Delete data now". Anlatım: "Read-only access, used only to show search reports and recommendations to you."

---

## 8. Test ve doğrulama stratejisi

Asgari kapı GA planındakiyle aynıdır: `tsc` + `eslint` + yeni ve etkilenen testler.

| Katman                       | Kapsam                                                                                                                                                                                                                                                                                                                                                                        | Yöntem                                                                                                 | Ortam         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------- |
| Sözleşme                     | Search Analytics (satırlar, boş yanıt, `first_incomplete_date`, 25.000 satırlık sayfalama, `hourly_all`), "quota exceeded", load kotası, 403 yetki, `sites.list` yetki düzeyleri, `sitemaps.list/get`, URL Inspection sonuç varyantları (PASS/FAIL, canonical farkı, robots engeli, `richResultsResult`), CrUX kaydı ve geçmişi                                               | Kayıtlı fikstürler (`src/server/integrations/search-console/__fixtures__/`) + `vi.stubGlobal("fetch")` | CI            |
| Birim                        | PT tarih hesapları, marka sınıflayıcı, niyet kuralları, CTR eğrisi (monotonluk), her SO/SH/TA kuralının sınır değerleri, yamyamlaşma tespiti, çürüme neden sınıflaması, fark-içinde-fark ve bootstrap, robots ayrıştırma (Google kuralları), sitemap ayrıştırma (index ve `.gz`), HTML denetimi (meta/başlık noindex, göreli canonical, hreflang, bozuk JSON-LD), PII süzgeci | Vitest, saf modüller                                                                                   | CI            |
| Entegrasyon (DB)             | Sözlük upsert'i, haftalık birleştirme, arşiv saklama kuralları, inceleme bütçesi sayacı (PT günü), kilit/CAS, eylem durum makinesi, Disconnect'in yalnız `Gsc*`'yi silmesi                                                                                                                                                                                                    | Tek kullanımlık yerel Postgres                                                                         | Yerel         |
| Tarayıcı davranışı           | Saniyede ≤ 1 istek, robots.txt'ye uyum, yalnız doğrulanmış alan adı, yönlendirme ve SSRF korumaları, koşullu GET                                                                                                                                                                                                                                                              | Sahte `Transport` (`safe-fetch` DI deseni)                                                             | CI            |
| Uçtan uca                    | agentelse.com ve bir gerçek site: kesin günlerin toplamları GSC arayüzüyle ±%1; geri doldurma; anonim payı; tatbikat olarak hazırlık sayfasına `noindex` → 6 saat içinde CRITICAL                                                                                                                                                                                             | Gerçek mülk; yerel senkron yalnız `GSC_SYNC_DEV_PROJECTS` ile                                          | Yerel / canlı |
| Zaman ve biçim               | PT günleri ve PT'ye göre ISO haftaları; yaz saati geçişleri; URL Inspection bütçesinin PT gece yarısında sıfırlanması; `first_incomplete_date` sınırı; rapor dilinde sayı biçimi (TR, EN, MK)                                                                                                                                                                                 | Saf testler, sabitlenmiş saat (`vi.setSystemTime`)                                                     | CI            |
| Site taşıma tatbikatı (SH27) | Test sitesinde değerli bir URL'nin 404'e düşürülmesi ve ana sayfaya toplu yönlendirme; yönlendirme haritası önerisinin doğruluğu                                                                                                                                                                                                                                              | Sahte `Transport` + fikstür; ardından agentelse.com'da hazırlık sayfası                                | CI / yerel    |
| Gölge mod                    | Fırsat bulguları                                                                                                                                                                                                                                                                                                                                                              | `SEO_INSIGHTS=shadow` ile 2 hafta; sahip 30 bulguyu inceler                                            | Canlı         |
| Canlı doğrulama              | Uzlaştırma bekçisi, kota, inceleme kullanımı, tarama sayaçları, nabız                                                                                                                                                                                                                                                                                                         | Günlük iş + /health                                                                                    | Canlı         |

Mevcut testler korunur ve taşınır: `quick-wins.test.ts`, `on-page.test.ts`, `research.test.ts`, `seo-rules` testleri (yeni kural kütüphanesine).

---

## 9. Fazlı yol haritası

Önerilen sıra: SC-F0 → SC-F1 → SC-F2 → SC-F3 → SC-F4 → SC-F5 → SC-F6 → SC-F7 → SC-F8 → SC-F9. Her fazdan sonra `docs/search-console.md` güncellenir. İlerleme raporlarında hangi ekranda neyin değiştiği yazılır (rota, kart adı, görünen metin, bayrak, migration).

**Kademeli açılış ve geri dönüş:** GA planı §9'daki adımların aynısı; izin listesi `GSC_ROLLOUT_PROJECTS`. Site tarayıcı (SC-F3) canlıda önce yalnız agentelse.com ve sahibin onayladığı bir müşteri sitesinde açılır; tarama hızı ve robots.txt uyumu bir hafta izlenmeden herkese açılmaz.

### SC-F0 — Önkoşullar · S

**Amaç:** Google ve site tarafındaki engelleri erken görmek.

**Sahip adımları (kod dışı):**

1. GA-F0'daki Cloud kontrolleri (yayın durumu, izin sınıfları, API'ler, doğrulama).
2. agentelse.com'u (ve agentelse.ai'yi) Search Console'da doğrulamak.
3. SK1-SK7 kararları.

**Kapsam (kod):** REVOKED koruması (GA-F0 ile aynı değişiklik). **Yapıldı (6 Ekim, commit'siz):** aynı düzeltme Search Console'un liste yenileme ve test yollarını da kapsıyor (`google-actions.test.ts`).

**Migration:** Yok.

**Kabul ölçütleri:** GA-F0 ile aynı; Search Console'da doğrulanmış en az bir test sitesi var.

**Bağımlılık:** Yok.

### SC-F1 — Bağlantı ve kimlik · M

**Durum (6 Ekim):** Bölüm 1 ve 2, GA-F1 ile birlikte yapıldı ([google-connections.md](google-connections.md)). Search Console'a özgü olanlar: site listesinde projenin sitesini kapsayan mülkler ve Domain mülkü önce, seçili site projenin sitesini kapsamıyorsa uyarı, `scope_missing` mesajı, günlük sağlık uyarıları, "Use existing connection". Plandan fark: `GoogleGrant` kurulmadı; refresh token kopyalanarak paylaşılıyor, bu yüzden `GscSiteLink` yalnız `credentialId` taşır (GA planı GA-F1 durum notu). "Delete data now" SC-F2 tablolarıyla gelir.

**Amaç:** GA-F1 ile aynı; Search Console'a özgü site doğrulamasıyla.

**Kapsam:**

- Ortak çekirdek ve grant (GA-F1 ile birlikte yazılır).
- `sites.list` yetki düzeyleri, Domain mülkü önerisi, URL önekli mülkte sonda eğik çizgi, `Project.domain` eşleşme uyarısı, platform mülklerinin ayrılması.
- Search Console diyaloğunda durum, "Connected as", izin eksikliği, Disconnect ve "Delete data now".
- Gizlilik metninde Search Console kısmı (GA-F1'deki ortak Google bölümü).

**Migration:** `<ts>_add_google_grant` (GA-F1 ile ortak; bir kez).

**Bayrak:** Yok (`GOOGLE_GRANT_SHARING` ortak).

**Kabul ölçütleri:**

- İzin kutusu kaldırılınca bağlantı oluşmuyor (testli).
- Domain mülkü varken URL önekli bir mülk seçilirse öneri görünüyor.
- Alan adı uyuşmazlığında uyarı çıkıyor.
- GSC'nin Disconnect'i, aynı hesabın aktif bir GA bağlantısı varken Google'da iptal çağırmıyor (testli).

**Bağımlılık:** SC-F0.

**Görünür değişiklik:** Search Console diyaloğunda site kartı ve alan adı uyarısı.

### SC-F2 — Arama ambarı · L

**Durum (6 Ekim):** Uygulandı (`GSC_SYNC`, `GSC_SEARCH_PAGE` bayraklı, canlı denenmedi); uygulanan hâl [search-analytics.md](search-analytics.md)'de. Plandan farklar:

- `grantId` yok (GA-F1 notu); bağ yalnız `credentialId` taşır.
- Fazladan tablo `GscPeriodFetch`: hangi hafta/ay özetinin çekildiği, kırpılma bayrağı ve satır toplamları (anonim pay buradan).
- Pozisyonlar her yerde `positionWeighted` (pozisyon × gösterim) olarak saklanır; CTR ve dönem pozisyonu okurken hesaplanır.
- Marka ayrımı Google tarafında regex süzgeciyle (Unicode sınırları, `\b` yok) günlük seri olarak tutulur; terim değişince 90 günlük geri doldurma parçalarıyla yeniden çekilir.
- query×page dışında her istek ≤ 90 gün; böylece "heavy" kota bloğu toplamları hiç durdurmaz.
- Uzlaştırma bekçisi yerine boşluk tespiti + boşluk geri doldurması.
- Marka terimi düzenleme Settings yerine Search sayfasında ve Connectors'ta.
- Arşiv anahtarı ve "Delete stored data" Connectors'ta.
- Günlük kırılımlar 16 aydan sonra aylık satırlara toplanır.
- Site değişince eski bağ `demotedAt` ile işaretlenir, 30 gün sonra silinir.
- Kademeli açılış için `GSC_ROLLOUT_PROJECTS`.

Ertelenenler: saatlik erken uyarı sorgusu, sitemap senkronu (SC-F3), uzlaştırma uyarısı, Analytics modülünde en iyi sayfalar, haftalık görsel (image) özetleri, "All history" dönemi.

**Amaç:** Arama verisini eksiksiz, doğru tarihli ve kalıcı hale getirmek; tüm okuyucuları tek kaynağa bağlamak.

**Kapsam:**

- `src/server/integrations/search-console/*` (PT tarihleri, `dataState`, sayfalama, kota yöneticisi).
- `src/server/seo/sync/*`, `store.ts`, `gsc-sync` adımı ve nabız.
- Sözlükler, haftalık ve aylık özetler, 16 aylık geri doldurma, arşiv.
- Marka terimlerinin ilk sürümü (Brand Brain adı + alan adı; düzenleme Settings'te).
- Okuyucuların geçişi: Analytics modülü (`collectSearchConsole` → `store`), SEO Manager quick wins, fikir motoru (`generateSeoIdeas`).
- "Search" sayfası v1 (`/projects/[projectId]/arama`): KPI başlığı (marka dışı / marka / toplam), trend, sorgular, sayfalar, anonim pay, tazelik notları; Brand sekmesinde "Search" kartı.
- `seo-retention` ve yerel geliştirme koruması.

**Migration:** `<ts>_add_gsc_warehouse` (`GscSiteLink`, `GscDailyTotal`, `GscDailySlice`, `GscQuery`, `GscPage`, `GscWeeklyQuery`, `GscWeeklyPage`, `GscWeeklyQueryPage`, `GscMonthlyQuery`, `GscMonthlyPage`).

**Bayraklar:** `GSC_SYNC=true`, `GSC_SEARCH_PAGE=true`.

**Kabul ölçütleri:**

- Kesin günlerin toplamları GSC arayüzüyle ±%1 tutuyor.
- Karşılaştırmalarda hiçbir eksik (kesinleşmemiş) gün "düşüş" olarak görünmüyor (testli).
- 16 aylık geri doldurma KOBİ sitesinde 30 dakikanın altında bitiyor ve kesilirse kaldığı yerden sürüyor.
- Anonim pay gösteriliyor.
- SEO Manager quick wins ambardan geliyor.
- Search sayfası 1 saniyenin altında açılıyor.

**Bağımlılık:** SC-F1.

**Görünür değişiklik:** Yeni "Search" sayfası; Brand sekmesinde "Search" kartı; Analytics modülünde marka ayrımlı GSC bölümü; Integrations'ta "Final data through …".

### SC-F3 — Arama sağlığı ve teknik denetim · L

**Durum (6 Ekim):** Uygulandı (`SEO_HEALTH`, `SEO_CRAWL` bayraklı, canlı denenmedi); uygulanan hâl [search-health.md](search-health.md)'de. Plandan farklar:

- htmlparser2 yerine kendi tokenizer'ımız (SK4); robots, sitemap ve JSON-LD ayrıştırıcıları da el yazımı.
- GSC'si olmayan projeler için Agentelse meta etiketi / DNS TXT doğrulaması.
- Ek tablolar `SeoSite` ve `GscCoverageWeek`; `SeoPage` taban çizgisi geçişiyle sitemap envanterini de tutar.
- `SearchUpdate` olay kimliğiyle (incident id) anahtarlı.
- Yalnız ana host (eş host yalnız kendi robots.txt'si altında bir yönlendirme adımı olarak).
- SH4: `*` grubunda `Disallow: /` da CRITICAL; asset/sitemap engelleri WARN; robots 5xx yalnız tur içi yeniden denemeden sonra CRITICAL.
- SH5 ağ hataları iki ardışık kontrol ister.
- TA18 3 MB sayfa ağırlığı yerine 2 MB HTML sınırı (ve 1,5 sn TTFB).
- Karışık kontroller veri kaynağına göre bölündü (GSC_* / SEO_*).
- Uyarılar AdsAlert.source üzerinde SiteAlerts ile; GSC uyarıları operatöre hiç gitmez, CRITICAL olanı projenin kendi Telegram'ına yalnız genel ifadeyi gönderir; SEO uyarıları yalnız projenin kendi Telegram'ına.
- Works "Needs attention" kartı yerine Today özeti + sıradaki adım.
- Ayarlar Search sayfasındaki bölümde.
- Kapsam tahmini SEO_CRAWL ister.

Ertelenenler: SH2 saatlik erken uyarı, grafik notları, Integrations rozeti, inceleme bütçesi ayarı, PSI, ikincil hostlar, `inspect_url` (SC-F4), SeoAction P1 (SC-F6).

**Amaç:** Siteyi Google'ın gözünden ve kendi tarayıcımızla sürekli denetlemek; felaketleri saatler içinde yakalamak.

**Kapsam:**

- URL Inspection örnekleyicisi (`gsc-inspect`), kapsam tahmini.
- Sitemap ve robots izleme (kendi okumamız + GSC).
- Site tarayıcı (`src/server/seo/crawl/*`; SK4 bağımlılığı onaylanınca), TA1-TA24 kataloğu, iç link grafiği.
- 6 saatlik gerileme bekçisi.
- CrUX ile Core Web Vitals (SK7 anahtarı).
- Google güncellemeleri takvimi (`SearchUpdate`, `search-updates-sync`).
- SH1-SH27 (SH27: kaybolan değerli URL'ler ve yönlendirme haritası), `MonitorAlert` (`source = "GSC"` / `"SEO"`; fiziksel tablo `AdsAlert`), Search health puanı, düzeltme rehberleri.
- Works "Needs attention" ve sıradaki adım şeridine SEO adımları.
- `agentelse.com/bot` sayfası (marketing uygulamasında).

**Migration:** `<ts>_add_seo_health_and_crawl` (`GscUrlInspection`, `GscSitemap`, `SeoCrawl`, `SeoPage`, `SeoLink`, `SeoCwv`, `SearchUpdate`).

**Bayraklar:** `SEO_HEALTH=true`, `SEO_CRAWL=true`.

**Kabul ölçütleri:**

- Tatbikat: hazırlık sayfasına `noindex` eklenince ≤ 6 saatte CRITICAL; robots.txt'ye `Disallow: /` eklenince CRITICAL.
- İnceleme bütçesi PT gününe göre aşılmıyor (testli).
- Tarayıcı saniyede ≤ 1 istek atıyor ve robots.txt'ye uyuyor (testli).
- Kapsam tahmini aralığıyla gösteriliyor.
- CWV origin değerleri CrUX'la aynı.
- Telegram mesajında sorgu, URL ya da sayı yok (testli).

**Bağımlılık:** SC-F2 (tarayıcı ve CWV, GSC'siz projede `Project.domain` doğrulanmışsa tek başına da çalışır).

**Görünür değişiklik:** Search sayfasında "Index & technical health" paneli, "Search health 81/100" rozeti; Works'te "Your homepage is set to noindex" gibi kritik kartlar.

### SC-F4 — SEO fırsat motoru · L

**Durum (6 Ekim):** Uygulandı (bayraklı, canlı denenmedi); uygulanan hâl [search-opportunities.md](search-opportunities.md)'de. Plandan farklar:

- Site başına tek CTR eğrisi (marka dışı + marka); cihaz başına eğri yok.
- Niyet LLM'i 200 yerine 20'lik paketlerle çalışır (Limited Use).
- Günlük toplam anomalisi SC-F3 SH2'de kalır.
- SC-F4 uyarı üretmez.
- Sinyaller yalnız genel metin taşır (SO3, SO6, SO7, SO9, SO10, SO13).
- "From your search data" fikir etiketi ertelendi (kaynak hâlâ "Search").
- GA değer köprüsü ertelendi.
- Sohbet araçları yalnız ambarı okur (canlı P1 yok).
- Marka terimi önerileri Search sayfasındadır.
- Gölge inceleme sahibin kendi Search sayfasında, sayaçlar /health/search-opportunities'te.
- Ek tablolar: `SeoEngineState` ve `SeoQueryEmbedding`.
- SO12 Review/Event/LocalBusiness alt türleri olmadan, SO9 pozisyon eğilimi olmadan.

Ertelenenler: SeoAction / "Fix this" (SC-F6), GA köprüsü, cihaz başına eğriler, "Search & SEO" sohbeti (SC-F5).

**Amaç:** Fırsatları profesyonel yöntemlerle bulmak ve etkiyle önceliklendirmek.

**Kapsam:**

- `src/lib/seo/rules/*` (SO1-SO16), CTR eğrisi, marka sınıflayıcı, niyet, konu kümeleri (SK13), etki ve öncelik.
- `SeoFinding`, `SeoCluster`; `seo-opportunities` adımı.
- Sinyal (tarihli `externalRef`) ve fikir akışı (`generateSeoIdeas` kanıtlı fırsatlarla beslenir).
- Sohbet araçları (beş araç; `external: true`).
- Kaldırılanlar: `google-analytics-scanner.ts`'in GSC kısmı ve `seo-rules.ts`'teki `CONTENT_OPPORTUNITY` (`SEO_INSIGHTS=on` ile). `quick-wins.ts` yeni kütüphaneyi kullanır.
- Search sayfasında "Opportunities" listesi (etki, güven, emek); fikir panosunda "From your search data".
- Gölge mod listesi.

**Migration:** `<ts>_add_seo_finding_and_clusters`.

**Bayrak:** `SEO_INSIGHTS=off|shadow|on`.

**Kabul ölçütleri:**

- Her kuralın sınır testleri var; CTR eğrisi monoton (testli).
- Marka sınıflayıcısı sahibin sitesinde ≥ %90 isabetli (elle örneklem).
- Gölge modda 30 bulgunun ≥ %70'i "yararlı".
- Aynı fırsat farklı haftalarda yeniden değerlendirilebiliyor (testli).
- Sohbette "Which pages should I improve first?" sorusu ambar sayılarıyla yanıtlanıyor.

**Bağımlılık:** SC-F3 (içerik boşluğu ve iç link kuralları tarayıcı verisi ister; diğerleri SC-F2 ile çalışır).

**Görünür değişiklik:** Search sayfasında öncelikli fırsat listesi; SEO Manager'da CTR eğrili quick wins; fikir panosunda kanıtlı SEO fikirleri.

### SC-F5 — Raporlama ve planlama · M

Durum (6 Ekim 2026): Kodlandı (SEO_REPORTS); ayrıntılar [search-reports.md](search-reports.md). Plandan sapmalar:

- Migration var (3 tablo: değişmez, silinebilir anlık görüntüler için).
- seo-pulse/seo-weekly-report/seo-monthly-report tek tick adımı "seo-reports".
- Teşhis ağacında adım 2 ikiye bölündü: indeks (URL Inspection) ve teknik (tarayıcı).
- Rapor günleri ayarı ertelendi.
- Uyarılar sohbete yalnız nabız kartında sayı olarak gelir.

**Amaç:** Profesyonel ritimde SEO raporu, teşhis ve hedefe bağlı plan.

**Kapsam:**

- `src/server/seo/reports/{pulse,weekly,monthly,diagnose,forecast,goals,roadmap}.ts`.
- "Search & SEO" sohbeti (`wkseo_<projectId>`) ve saklanan rapor kartları; `page.tsx` sohbet sorgusuna kart türü.
- Teşhis ağacı; SEO hedefleri (`ProjectGoal`), tahmin; "SEO roadmap" kartı.
- Dışa aktarma (Analytics modülünün `export.ts` ve `share.ts`'i).

**Migration:** Yok.

**Bayrak:** `SEO_REPORTS=true`.

**Kabul ölçütleri:**

- Haftalık rapor yalnız kesin veriyle çıkıyor; her sayı ambara dayanıyor (number-check).
- Teşhis ağacı tatbikat verisinde doğru adımı buluyor (testli).
- Hedeflerin `currentValue` değeri günlük güncelleniyor.
- Aylık rapor dışa aktarılabiliyor.

**Bağımlılık:** SC-F4 (KPI bölümü SC-F2 ile de çalışır).

**Görünür değişiklik:** Projede "Search & SEO" sohbeti; "Weekly SEO report" ve "SEO roadmap" kartları; Goals'ta SEO hedefleri.

### SC-F6 — Öneri döngüsü · M

**Durum (7 Ekim 2026):** kodlandı (`SEO_ACTIONS`; migration `20261006218000_add_seo_action`); ayrıntı ve kayıtlı sapmalar [search-actions.md](search-actions.md). Canlıda denenmedi.

**Amaç:** Her öneriyi uygulanan, doğrulanan ve ölçülen bir eyleme çevirmek; SEO Manager'ı mevcut sayfaları da iyileştirir hale getirmek.

**Kapsam:**

- `SeoAction`, `seo-action-verify` ve `seo-action-evaluate` adımları, değerlendirme yöntemi (§6.4), `BrandLearning` (`sourceType = "SEO"`).
- SEO Manager: "Refresh a page", "Fix the snippet", fırsattan açılış, "Write another", arka planda canlı iş (SSE), Brief dili kuralı, `liveSlotCount` düzeltmesi (§2.3).
- Search sayfasında "Actions & results" bölümü.

**Migration:** `<ts>_add_seo_action`.

**Bayrak:** `SEO_ACTIONS=true`.

**Kabul ölçütleri:**

- Başlık değişikliği tarayıcıyla otomatik doğrulanıyor (fikstürle testli).
- Fark-içinde-fark ve bootstrap testleri geçiyor.
- Google güncellemesiyle çakışan pencere INCONCLUSIVE oluyor (testli).
- Öğrenme yalnız kapıyı geçen sonuçtan yazılıyor.
- SEO Manager açık kalanları kapandı.

**Bağımlılık:** SC-F4.

**Görünür değişiklik:** Fırsat kartında "Fix this"; SEO Manager'da yeni modlar; Search sayfasında eylemlerin sonuçları ("Worked: +18% CTR").

### SC-F7 — İçerik planı · M

**Amaç:** Arama verisinden aylık, kümelere dayalı bir içerik planı üretmek.

**Kapsam:**

- Konu kümelerinden pillar/cluster haritası; aylık SEO içerik takvimi (`seo` kanalı postları, mevcut takvim).
- Fikir motoru ve haftalık taslakla bağ (Faz 4): SEO makaleleri de taslağa girebilir.
- İç link planı (yeni makalenin hangi sayfalardan link alacağı).
- §6.5 kalite rayları (aylık sınır, insan onayı, kapı sayfası yasağı).

**Migration:** Yok (`SeoCluster` SC-F4'te geldi).

**Bayrak:** `SEO_CONTENT_PLAN=true`.

**Kabul ölçütleri:**

- Plan, kümelerin gösterim payına ve boşluklara dayanıyor.
- Aylık sınır aşılmıyor (testli).
- Her makale Review'dan geçmeden takvime "APPROVED" girmiyor.

**Bağımlılık:** SC-F6.

**Görünür değişiklik:** "SEO roadmap" kartında "This month's articles"; takvimde SEO parçaları.

### SC-F8 — Uygulama katmanı ve AI arama görünürlüğü · L

**Amaç:** Onaylı ve geri alınabilir uygulama; AI aramada görünürlük.

**Kapsam:**

- Ayrı CMS entegrasyonları; her biri kendi plan dokümanıyla (önce WordPress). `WEBSITE_UPDATE` sağlayıcısı, Task + Approval, önce/sonra anlık görüntüsü, geri alma, hız sınırı.
- İsteğe bağlı IndexNow.
- GEO/AEO denetimi ve önerileri (§3.9); GA köprüsünden AI trafiği.

**Migration:** CMS planlarına göre.

**Bayraklar:** `SEO_APPLY=true`, `SEO_GEO=true`.

**Kabul ölçütleri:**

- Onaysız hiçbir site yazması yok (testli).
- Her yazma geri alınabiliyor.
- Taslak varsayılanı çalışıyor.
- Search Console'a hiçbir yazma isteği gitmiyor; istemci yalnız okuma uçlarını içeriyor (testli).

**Bağımlılık:** SC-F6 + ilgili CMS entegrasyonu.

**Görünür değişiklik:** SEO Manager'da "Publish to WordPress (draft)"; fırsatlarda "Apply with approval".

### SC-F9 — Ajans ve büyük site · L

**Amaç:** Büyük siteler ve çok müşterili ajanslar.

**Kapsam:**

- **BigQuery toplu dışa aktarımı:** Yalnız mülk sahibi açabilir; faturalı bir Cloud projesi gerekir; geriye dönük doldurma yoktur (önceki geçmiş API'den gelir). Okuma yolu: müşteri kendi veri kümesinde Agentelse'in servis hesabına okuma yetkisi verir (yeni OAuth izni gerekmez; doğrulanmalı).
- Sayfa grupları yönetimi (şablon kuralları).
- İsteğe bağlı ücretli SERP verisi (sıralama takibi, rakipler; SK12).
- Bölünmüş SEO testleri (§6.4).
- Proje başına birden çok site; workspace "Search" genel görünümü; beyaz etiketli raporlar.

**Migration:** Gerektiği kadar.

**Bayrak:** `GSC_AGENCY=true`.

**Kabul ölçütleri:**

- 50.000 satır sınırına takılan bir sitede BigQuery yolu tam veri veriyor.
- Ajans görünümü 20 siteyi listeliyor.

**Bağımlılık:** SC-F5.

---

## 10. Riskler ve azaltımlar

| Risk                                                  | Olasılık / etki | Azaltım                                                                                                                                                     |
| ----------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16 ay sınırı; BigQuery'de geriye dönük doldurma yok   | Yüksek / yüksek | SC-F2 erken yapılır; kalıcı arşiv                                                                                                                           |
| Veri gecikmesi ve PT günleri                          | Yüksek / orta   | `first_incomplete_date`, "fresh" işareti, PT etiketi                                                                                                        |
| Anonim sorgular ve günlük 50.000 satır sınırı         | Orta / orta     | Anonim pay gösterilir; büyük sitede BigQuery (SC-F9)                                                                                                        |
| Pozisyonun yanlış yorumlanması                        | Orta / orta     | "Average top position" etiketi; sıralama takibi iddiası yok                                                                                                 |
| AI Overviews'un CTR'yi düşürmesi                      | Yüksek / orta   | Çürüme sınıflamasında "CTR loss at stable position"; beklenti yönetimi                                                                                      |
| Tarayıcının engellenmesi (WAF, Cloudflare)            | Orta / orta     | Açık UA, bot sayfası, izin listesi rehberi; engelde TA verisi "unknown"                                                                                     |
| Müşteri sitesine yük                                  | Düşük / orta    | Saniyede 1 istek, robots.txt, koşullu GET, gece taraması                                                                                                    |
| SSRF ve kötüye kullanım                               | Düşük / yüksek  | `safe-fetch`; yalnız doğrulanmış alan adı                                                                                                                   |
| Taranan içerikten prompt injection                    | Orta / yüksek   | Veri bloğu, temizleme, `external` taint, çıktı doğrulama                                                                                                    |
| Spam politikalarına aykırı öneren LLM                 | Orta / yüksek   | §6.5 rayları, aylık sınır, insan onayı                                                                                                                      |
| Değerlendirme yanılgısı (güncelleme, sezon)           | Yüksek / orta   | Kontrol grubu, YoY, güncelleme çakışmasında INCONCLUSIVE tavanı, dürüst raporlama                                                                           |
| URL Inspection kotası                                 | Düşük / düşük   | Bütçe ve öncelik kuyruğu                                                                                                                                    |
| Depolamanın büyümesi                                  | Orta / orta     | Sözlükler, ilk-N sınırları, saklama; 100 sitede ~1-2 GB                                                                                                     |
| Hukuki: kalıcı arşiv                                  | Düşük / yüksek  | Açık beyan, ayar, silme; hukuki görüş (doğrulanmalı)                                                                                                        |
| Search Console'un yeni özelliklerinin API'de olmaması | Yüksek / düşük  | Operatör kontrolü; API'ye gelince bayrakla eklenir                                                                                                          |
| CMS yazmalarında hata (SC-F8)                         | Orta / yüksek   | Taslak varsayılanı, onay, anlık görüntü, geri alma, hız sınırı                                                                                              |
| Yeni bağımlılık (HTML ayrıştırıcı)                    | Düşük / düşük   | Küçük ve yaygın bir paket; sahibin onayı                                                                                                                    |
| Google'da ortak izin kaydı (GA ile)                   | Orta / orta     | Akıllı iptal (GA planı §3.2, testli); tek proje kararı (SK1) nedeniyle Google hesabından kaldırma iki servisi birlikte düşürür, token sağlığı bunu gösterir |

---

## 11. Sahibin vermesi gereken kararlar

| #    | Karar                                                                  | Seçenekler                                                                                                                                                                                                              | Önerilen                                                                                                 | Gerektiği faz |
| ---- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------- |
| SK1  | Google Cloud projesi                                                   | GA planı GK1 ile aynı karar                                                                                                                                                                                             | **Karar verildi (6 Ekim):** ayrı bağlanma, tek proje, tek doğrulama + akıllı iptal; ikinci doğrulama yok | SC-F1         |
| SK2  | Eski ortak token'lar                                                   | GA planı GK2 ile aynı karar                                                                                                                                                                                             | `legacy_combined` grant                                                                                  | SC-F1         |
| SK3  | Arşiv                                                                  | (a) Günlük toplamlar ve aylık özetler süresiz, haftalık özetler 36 ay, sorgu×sayfa 16 ay; bağlanırken beyan, ayardan kapatılabilir; (b) yalnız Google'ın 16 ayı                                                         | (a)                                                                                                      | SC-F2         |
| SK4  | HTML ayrıştırıcı                                                       | (a) `htmlparser2` (yeni bağımlılık); (b) `parse5`; (c) mevcut regex çıkarıcıyı genişletmek                                                                                                                              | (a)                                                                                                      | SC-F3         |
| SK5  | Tarama sınırları ve kimliği                                            | (a) Haftada 500 sayfa, saniyede 1 istek, robots.txt'ye uyum, `AgentelseSiteAudit/1.0` + bot sayfası, yalnız doğrulanmış alan adı; (b) daha agresif                                                                      | (a)                                                                                                      | SC-F3         |
| SK6  | URL Inspection bütçesi                                                 | (a) Site başına günde 200; (b) 500; (c) 2.000 (Google sınırı)                                                                                                                                                           | (a); ajans planında artar                                                                                | SC-F3         |
| SK7  | CrUX anahtarı                                                          | (a) Yeni ve kısıtlı `GOOGLE_API_KEY`; (b) CWV yok                                                                                                                                                                       | (a)                                                                                                      | SC-F3         |
| SK8  | Marka terimleri                                                        | (a) Brand Brain + alan adı + LLM önerisi, kullanıcı onayıyla; (b) yalnız elle                                                                                                                                           | (a)                                                                                                      | SC-F2 / SC-F4 |
| SK9  | Raporların yeri                                                        | (a) Proje başına "Search & SEO" sohbeti; (b) yalnız Search sayfası                                                                                                                                                      | (a) + sayfada arşiv                                                                                      | SC-F5         |
| SK10 | Sitemap gönderimi ve `webmasters` (yazma) izni                         | (a) Hiç yapılmasın; entegrasyon salt okunur kalsın; (b) SC-F8'de artımlı izinle                                                                                                                                         | **Karar verildi (6 Ekim): (a).** Sitemap gönderimi yok, yazma izni istenmez, ek Google incelemesi yok    | —             |
| SK11 | İlk CMS entegrasyonu                                                   | (a) WordPress; (b) Shopify; (c) Webflow                                                                                                                                                                                 | (a); her biri ayrı plan                                                                                  | SC-F8         |
| SK12 | Ücretli SERP / sıralama API'si                                         | (a) Şimdilik yok; GSC ortalama pozisyonu yeter; (b) SC-F9'da değerlendirilir                                                                                                                                            | (a), sonra (b)                                                                                           | SC-F9         |
| SK13 | Sorgu kümelemede embedding                                             | (a) OpenAI embedding (düşük maliyet, sorgu başına bir kez); (b) yalnız kural tabanlı kümeleme                                                                                                                           | (a)                                                                                                      | SC-F4         |
| SK14 | AI içerik rayları                                                      | (a) KOBİ'de ayda 4 makale (en çok 12), insan onayı, kapı sayfası yok; (b) sınırsız                                                                                                                                      | (a)                                                                                                      | SC-F7         |
| SK15 | Eylem değerlendirme yöntemi                                            | (a) Kontrol gruplu öncesi/sonrası; (b) yalnız öncesi/sonrası                                                                                                                                                            | (a)                                                                                                      | SC-F6         |
| SK16 | Uyarı tablosu, kanal, roller, Disconnect, LLM verisi, doğrulama zamanı | GA planındaki GK3, GK5-GK8, GK11, GK12                                                                                                                                                                                  | Aynı öneriler                                                                                            | SC-F1 – SC-F3 |
| SK17 | Search Console "platform mülkleri" (Instagram/TikTok/X/YouTube)        | (a) API desteği gelince sosyal kanallarla birleştirmek; (b) kullanmamak                                                                                                                                                 | (a) (gelecek)                                                                                            | —             |
| SK18 | Kendi sitemizde deneme (agentelse.com)                                 | (a) Evet, ilk test sitesi; (b) hayır                                                                                                                                                                                    | (a)                                                                                                      | SC-F0         |
| SK19 | Backlink ve arama hacmi verisi (Search Console API'de yok)             | (a) Şimdilik yok: iç linkler kendi tarayıcımızdan, talep GSC gösterimi + web araştırmasından; (b) ücretli bir sağlayıcı (backlink + hacim); (c) Google Ads Keyword Planner (ayrı entegrasyon + Ads geliştirici token'ı) | (a); talep olursa SC-F9'da (b) ya da (c), SK12 ile birlikte                                              | SC-F9         |
| SK20 | Rapor ve öneri metinlerinin dili                                       | GA planı GK17 ile aynı karar                                                                                                                                                                                            | Projenin içerik dili                                                                                     | SC-F5         |

---

## 12. Google Analytics ile ilişki (iki ayrı entegrasyonun köprüsü)

**Bağımsızlık kuralları:**

- Search Console ve SEO motoru, GA bağlı olmadan eksiksiz çalışır. Hiçbir SEO ekranı, işi ya da kuralı GA'ya bağımlı değildir.
- İzin, token (grant), tablolar, işler, sağlık, bayraklar, Disconnect ve silme ayrıdır. Google tarafındaki ortak izin kaydı GA planı §3.2'deki akıllı iptalle ele alınır.
- Ortak olan yalnız kod çekirdeği, `MonitorAlert`, `SystemHeartbeat` ve ürün döngüsüdür.

**Köprü.** Yalnız iki entegrasyon da aynı projede bağlıysa ve alan adları eşleşiyorsa çalışır. Köprünün kodu bu plandadır (`src/server/seo/bridge/ga.ts`); GA tarafı yalnız bir okuma API'si sağlar: `getLandingPageOutcomes(projectId, range)`.

1. **Değere göre önceliklendirme:** fırsatın `impact` değeri, sayfanın organik Google oturumu başına key event oranı ve değeriyle çarpılır. Örnek: "If this page reaches position 3: about +40 visits and +2 leads a month (directional)."
2. **İzleme kaybı tespiti:** GSC tıklaması ile GA'daki organik Google oturumu arasındaki oran sayfa ve site düzeyinde izlenir. Oranın düzeyi normaldir (tıklama ≠ oturum); yalnız **ani değişimi** bir bulgudur ve GA planının ölçüm kontrollerine sinyal olarak gider.
3. **Eylem değerlendirmesinde dönüşüm:** `SeoAction` değerlendirmesine tıklamanın yanında GA key event'leri de eklenir ("Worked: +22% clicks, +3 leads").
4. **AI arama görünürlüğü:** GA'daki AI asistan trafiği (GA planı AN7), SC-F8'deki GEO bölümünün ölçüsüdür.

GA4'ün kendi Search Console bağlantısı (`organicGoogleSearch*` metrikleri) yalnız açılış sayfası, ülke ve cihaz boyutlarını verir; sorgu düzeyinde veri yoktur. Bu yüzden Agentelse'in SEO motoru her zaman Search Console API'sini kullanır.

---

## Ek A. Temel Google kaynakları

- **Search Console API:** [API dizini](https://developers.google.com/webmaster-tools/v1/api_reference_index) · [searchAnalytics.query](https://developers.google.com/webmaster-tools/v1/searchanalytics/query) · [Bütün veriyi almak](https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data) · [Kullanım sınırları](https://developers.google.com/webmaster-tools/limits) · [URL Inspection sonucu](https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult) · [Sitemaps](https://developers.google.com/webmaster-tools/v1/sitemaps) · [Sites](https://developers.google.com/webmaster-tools/v1/sites)
- **Search Central blog ve yardım:** [Saatlik veri (Nisan 2025)](https://developers.google.com/search/blog/2025/04/san-hourly-data) · [Güncel veri (Aralık 2024)](https://developers.google.com/search/blog/2024/12/recent-data-search-console) · ["Web: multimodal" (Eylül 2026)](https://developers.google.com/search/blog/2026/09/web-multimodal-in-sc) · [Sayım kuralları (AI Overviews / AI Mode)](https://support.google.com/webmasters/answer/7042828) · [Gen-AI performans raporu](https://support.google.com/webmasters/answer/16984139) · [Anonim sorgular](https://support.google.com/webmasters/answer/17011259) · [Toplu dışa aktarım](https://support.google.com/webmasters/answer/12917675)
- **Core Web Vitals:** [CrUX API](https://developer.chrome.com/docs/crux/api) · [CrUX History API](https://developer.chrome.com/docs/crux/history-api) · [PageSpeed Insights API v5](https://developers.google.com/speed/docs/insights/v5/get-started)
- **OAuth ve politika:** GA planı Ek A ile aynı (100 token sınırı, granüler izinler, doğrulama, Limited Use, Hizmet Şartları, RISC).

## Ek B. Kısaltmalar

- **AEO / GEO:** yanıt motoru optimizasyonu / üretken arama motoru optimizasyonu (AI aramada görünürlük).
- **Ambar:** Search Console'dan çekilen verinin yerel kopyası.
- **CTR_adj:** pozisyona göre düzeltilmiş tıklama oranı (gerçek / beklenen).
- **CWV:** Core Web Vitals (LCP, INP, CLS).
- **DiD:** fark-içinde-fark (difference-in-differences).
- **Kilit sayfa:** ana sayfa + son 28 günde tıklamada ilk 20 sayfa.
- **PT:** Pasifik saati; Search Console günleri bu saat dilimindedir.
- **Vurucu mesafe:** ortalama pozisyonu 4-20 arasında olan, küçük bir iyileştirmeyle ilk sıralara çıkabilecek sorgu/sayfa.
