# Agentelse · Google Analytics 4: Mimari ve Uygulama Planı

Durum: Plan (6 Ekim 2026) — henüz uygulanmadı.

> **Kapsam:** Google Analytics 4 (GA4) entegrasyonu: bağlantı ve kimlik, yerel veri ambarı, ölçüm sağlığı denetimi, analiz, raporlama, planlama, reklam ölçümü ve öneri döngüsü. **Search Console ayrı bir entegrasyondur** ve kendi planı vardır: `docs/google-search-console-plan.md`. İki entegrasyon yalnız kod çekirdeğini paylaşır (OAuth, HTTP, hata kataloğu, PII süzgeci; §3.1). Bağlantı, izin, token, veri tabloları, işler, sağlık durumu, bayraklar, arayüz ve silme akışı tamamen ayrıdır; biri bağlı değilken diğeri eksiksiz çalışır. İkisi birden bağlıysa §12'deki isteğe bağlı köprü devreye girer.
>
> **Dayanak:** Üç kod haritası (bağlantı katmanı; analitik, işçi ve sohbet katmanı; site tarama, yayın linkleri ve test düzeni) ile Google'ın resmî dokümanlarından derlenen bir araştırma raporu (6 Ekim 2026 itibarıyla). Kod iddiaları repoda örneklenerek doğrulandı, örneğin `google-client.ts:161-209`, `google-token.ts:16-36`, `google-actions.ts:203-206,255-258,267-297`, `google-analytics-scanner.ts:165-189`, `seo-rules.ts:16-46`, `modules/analytics/google.ts:36-43,88` ve migration `20260929000000_split_google_integration`. Repo kodunda değişiklik yapılmadı.
>
> **(doğrulanmalı):** Bu işareti taşıyan Google davranışları ve alan adları, sahibin gerçek GA4 mülkünde denenmeden koda bağlanmamalı.
>
> **Kurallar:** Arayüz İngilizce; doküman ve kod yorumları Türkçe. AGENTS.md uyarısı geçerli: Next.js 16 dokümanı `node_modules/next/dist/docs/` altında okunur. Meta Ads planıyla (`docs/meta-ads-plan.md`) ortak altyapı (`SystemHeartbeat`, `/api/health`, harici bekçi, uyarı tablosu) tek kez kurulur; hangi plan önce uygulanırsa o kurar.

**İçindekiler:** 0 Özet · 1 Hedef davranış · 2 Mevcut durum ve boşluklar · 3 Hedef mimari (3.0–3.11) · 4 Veri modeli · 5 İşler, zamanlama ve kota bütçesi · 6 Profesyonel oyun kitabı · 7 Erişim ve Google doğrulaması · 8 Test · 9 Yol haritası · 10 Riskler · 11 Kararlar · 12 Search Console ile ilişki · Ek A Kaynaklar · Ek B Kısaltmalar

---

## 0. Özet

**Hedef.** Agentelse, markanın web sitesi için bir "AI analitik uzmanı" olacak. Bu uzman:

- GA4 verisini eksiksiz ve güvenle toplayıp yerelde saklayacak,
- ölçümün kendisini sürekli denetleyecek (veri akıyor mu, etiket doğru mu, key event çalışıyor mu, URL'lerde kişisel veri var mı),
- değişimleri nedenleriyle açıklayacak (hangi kanal, hangi sayfa; hacim mi, oran mı),
- günlük, haftalık, aylık ve müşteri raporları üretecek,
- hedefleri ve aylık planı bu veriye bağlayacak,
- reklamların (Meta ve GA4'e bağlıysa Google Ads) sitede gerçekte ne getirdiğini ölçecek,
- bulguları içerik, reklam ve SEO işlerine dönüştürüp her önerinin sonucunu ölçecek.

Her sayı kaynağı, dönemi, saat dilimi, tazeliği ve kalite bayraklarıyla gösterilir. Yapay zekâ sayı üretmez; yalnız koddaki analizleri anlatır ve önceliklendirir.

**Bugün nerede duruyoruz?** GA4 bağlantısı var ve 29 Eylül'den beri Search Console'dan ayrı bir entegrasyon (`google_analytics`). Analytics modül kartı, günlük tarayıcı ve `ANALYTICS_ANALYSIS` görevi bu bağlantıyı kullanıyor. Ancak:

- Veri saklanmıyor; her ekran canlı okuyor ve yalnız 2-6 toplam metrik biliniyor. Kanal, kaynak/ortam, kampanya, açılış sayfası ve key event hiç okunmuyor.
- Tarayıcı, örtüşen iki 7 günlük pencereyi tarama-tarama karşılaştırıyor. Bir bulgu bir kez üretildikten sonra aynı proje için bir daha hiç üretilemiyor (sinyal parmak izinde tarih yok).
- Callback, kullanıcının Google onay ekranında GA iznini kaldırıp kaldırmadığını kontrol etmiyor; bağlantı "Connected" görünüp her çağrı 403 alabiliyor.
- Disconnect token'ı silmiyor ve Google'da iptal etmiyor. "Run Test" ya da liste yenileme, koparılmış bağlantıyı yeniden ACTIVE yapabiliyor.
- 29 Eylül öncesi bağlananlarda GA ve Search Console aynı refresh token'ı (iki izinli) paylaşıyor.
- Her proje bağlantısı yeni bir refresh token üretiyor. Google'ın "Google hesabı × OAuth istemcisi başına 100 token" sınırı ajanslarda en eski bağlantıları sessizce düşürecek.
- Bir müşterinin Google izin hatası, global `google-api` sağlığını düşürüp herkesin analizini durdurabiliyor.
- Ölçüm sağlığı hiç denetlenmiyor. Agentelse'in yayınladığı hiçbir linkte UTM yok; GA4'te Agentelse'in getirdiği trafik ayırt edilemiyor.
- Gizlilik metninde Google bölümü ve Google'ın istediği "Limited Use" beyanı yok; bu, Google doğrulamasını engeller.

### En kritik 5 mimari karar

1. **Ayrı ve sertleştirilmiş bağlantı (GA-F1).** GA kendi izni (`analytics.readonly`), kendi token'ı, tabloları, işleri, sağlık durumu, bayrakları ve silme akışıyla yaşar. Callback verilen izni doğrular; token sağlığı her gün ölçülür. Aynı Google hesabı bir workspace'te tek bir "Google erişimi" (`GoogleGrant`) üzerinden birçok projeye bağlanır; böylece 100 token sınırına takılmayız. Disconnect token'ı hemen siler. Google'daki iptal ise yalnız güvenliyse yapılır, çünkü Google iptali Cloud projesi düzeyinde uygular ve aynı hesabın Search Console bağlantısını da koparır (§3.2).
2. **Yerel ambar ve rapor kataloğu (GA-F2).** Ekranlar, sohbet, raporlar ve kurallar canlı API yerine ambardan okur. Ambar, sabit bir rapor kataloğunu (14 rapor) mülk başına gün gün tutar. Geç gelen veri (7 gün) ve key event atfı (12 gün) için son günler her gün yeniden çekilir. Mülk başına kota yöneticisi `returnPropertyQuota` ile çalışır; günlük kullanım GA4 kotasının %1'inin altında kalır.
3. **Önce ölçüm sağlığı (GA-F3).** Analizden önce verinin kendisi denetlenir: 25 kontrol (veri akışı, etiket, çift sayım, key event, Unassigned, self-referral, ödeme geçidi, URL'de kişisel veri, saat dilimi, mülk-alan adı eşleşmesi…). Sonuç bir "Measurement health" puanı ve sade İngilizce düzeltme rehberleridir. Kritik bir ölçüm sorunu açıkken etkilenen günler analiz tabanlarından çıkarılır ve raporda "suspect" işaretlenir.
4. **Deterministik analiz, açıklayan yapay zekâ (GA-F4).** Şu analizler kodda çalışır ve istatistik kapılarından geçer: anomali (haftanın günü düzeltilmiş sağlam taban), değişim ayrıştırma (kanal ve sayfa düzeyinde hacim ve oran etkisi), açılış sayfası ve kanal kalitesi, AI asistan trafiği, site içi arama terimleri, reklam çapraz kontrolü. LLM yalnız anlatır ve önceliklendirir; number-check'ten geçmeyen cümle atılır.
5. **Kapalı döngü ve öğrenme (GA-F5, GA-F6).** Agentelse'in oluşturduğu her dış link ve reklam standart UTM taşır; GA4'teki oturum, key event ve gelir post, plan ve reklam bazında Agentelse'e geri bağlanır. Bulgular hedeflere (`ProjectGoal.currentValue`), fikir havuzuna, Brand Brain öğrenmelerine ve Meta Ads planındaki karar kaydına kanıt olarak akar. Her öneri, sonucu ölçülen bir kayıttır.

### Fazlar

Faz kodları `GA-F*` biçimindedir; "GA4" ürün adıyla karışmasın diye.

| Faz   | Tek satır                                                                                                                                                                        | Boyut |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| GA-F0 | Kod dışı önkoşullar (Google Cloud, yayın durumu, doğrulama hazırlığı) + acil düzeltme: koparılmış bağlantının yeniden ACTIVE olması                                              | S     |
| GA-F1 | Bağlantı ve kimlik: ortak Google çekirdeği, izin doğrulama, `GoogleGrant`, token sağlığı, akıllı iptal, gerçek Disconnect ve silme, roller, kiracıya özel sağlık, gizlilik metni | M     |
| GA-F2 | Ambar ve kota yöneticisi: rapor kataloğu, mülk metadata'sı, geri doldurma, revizyonlar, kalite bayrakları, okuyucuların ambara geçişi, "Website" sayfası v1                      | L     |
| GA-F3 | Ölçüm sağlığı denetimi: 25 kontrol, uyarılar, sağlık puanı, site etiketi tespiti, düzeltme rehberleri                                                                            | M     |
| GA-F4 | Analiz motoru: anomali, ayrıştırma, sayfa ve kanal kalitesi, AI trafiği, site araması, bulgu kaydı, sinyal ve fikir akışı, sohbet araçları                                       | L     |
| GA-F5 | Raporlama ve planlama: günlük nabız, haftalık/aylık/müşteri raporu, hedef temposu, tahmin, aylık plan kartı                                                                      | M     |
| GA-F6 | Kapalı döngü ve reklam ölçümü: UTM standardı, `TrackedLink`, Agentelse atfı, Meta ve Google Ads çapraz kontrolü, öğrenmeler                                                      | M     |
| GA-F7 | Düzeltme eylemleri (isteğe bağlı `analytics.edit`): key event işaretleme, saklama süresi, AI kanal grubu, notlar, değişiklik geçmişi                                             | M     |
| GA-F8 | Ajans ve ileri ölçek: proje başına çoklu mülk, workspace genel görünümü, beyaz etiketli müşteri raporu, BigQuery dışa aktarımı, huni ve 360                                      | L     |

Boyut ölçeği Meta Ads planıyla aynıdır (tek geliştirici + yapay zekâ desteği): **S** ≈ 1-2 gün, **M** ≈ 3-5 gün, **L** ≈ 1-2 hafta. Her faz tek başına canlıya çıkabilir ve kendi başına değer üretir.

**İki Google planının birlikte sırası (öneri):** GA-F0 + SC-F0 → GA-F1 + SC-F1 (ortak çekirdek ve bağlantı düzeltmeleri tek seferde; ikisi aynı dosyalardaki hataları paylaşıyor) → GA-F2 → GA-F3 → SC-F2 → SC-F3 → GA-F4 → SC-F4 → GA-F5 / SC-F5 → GA-F6 → SC-F6 … Planlar birbirini beklemez; yalnız çekirdek bir kez yazılır.

### Sahibin verdiği kararlar (6 Ekim 2026)

1. **Google Analytics ve Search Console ayrı ayrı bağlanır.** Bugünkü arayüzdeki gibi iki ayrı kutucuk, iki ayrı "Connect" düğmesi ve iki ayrı Google onay ekranı vardır; her onay ekranı yalnız kendi iznini ister. Token, mülk/site seçimi, Disconnect, veri silme, senkron, sağlık, raporlar ve sohbetler de ayrıdır. Bu plandaki hiçbir adım ikisini tek bağlantıda birleştirmez:
   - "Use existing connection" yalnız **aynı servisin** bağlantısını başka bir projede yeniden kullanır (GA'yı GA'ya bağlar; Search Console'a dokunmaz).
   - "GA-F1 + SC-F1 birlikte" ifadesi yalnız ortak kodun bir kez yazılması demektir; arayüzde ve veride ikisi ayrı kalır.
   - 29 Eylül öncesinin ortak token'ı yalnız geçiş içindir; o bağlantılar da arayüzde zaten ayrı görünür (GK2).
2. **Tek Google Cloud projesi, tek Google doğrulaması (GK1).** Mevcut proje ve OAuth istemcisi (`GOOGLE_OAUTH_CLIENT_ID`) kalır; ikinci bir Cloud projesi ve ikinci bir Google doğrulaması yapılmaz. `analytics.readonly` ve `webmasters.readonly` aynı doğrulama başvurusunda yer alır. Sonuçları:
   - Google izin kaydını Cloud projesi başına tuttuğu için, bizim Disconnect'imizin diğer servisi koparmaması "akıllı iptal" kuralıyla sağlanır (§3.2).
   - Kullanıcı Agentelse'i kendi Google hesabının ayarlarından kaldırırsa ve iki servise aynı hesapla bağlıysa ikisi birden düşer. Bu Google'ın davranışıdır; token sağlığı ikisini de "Needs reconnect" olarak gösterir.
   - Search Console tarafında yazma izni hiç istenmez: sitemap gönderimi yapılmaz (Search Console planı SK10, 6 Ekim).
   - GA tarafında yazma izni gerektiren tek faz isteğe bağlı GA-F7'dir (`analytics.edit`). Bu, mevcut doğrulamaya ek bir izin incelemesi ister (ikinci proje doğrulaması değil). İstenmezse GA salt okunur kalır ve düzeltmeler rehberle elle yapılır.

### Sahibin hemen vermesi gereken kararlar (GA-F0 – GA-F2'yi bloklayanlar)

Tam liste §11'de. Sahip 6 Ekim'de "eksikleri tamamla" dedi: bu listede ve §11'de bekleyen her kararda **"Önerilen" seçenek, sahip aksini söyleyene kadar varsayılan kabul edilir** ve uygulama ona göre yürür. Sahibin elinde olan adımlar yine sahipte kalır: yeni bir bağımlılığın eklenmesi (kodlanırken ayrıca sorulur), hukuki görüş, Google Cloud Console ayarları ve doğrulama başvurusu.

1. **Eski ortak token'lar (GK2).** 29 Eylül öncesi satırlar ortak bir "legacy" erişime taşınsın ve iki entegrasyon da çalışmaya devam etsin; Integrations'ta isteğe bağlı bir "Reconnect to separate" notu çıksın. _(Önerilen)_
2. **Disconnect (GK3).** Token hemen silinsin; ambar verisi 30 gün sonra silinsin ("Delete data now" ile hemen). _(Önerilen)_
3. **Saklama (GK4).** Günlük toplam ve kanal verisi 400 gün; yüksek kardinaliteli raporlar (sayfa, kaynak, kampanya) günlük 95 gün + haftalık 400 gün; aylık özetler 36 ay. Gizlilik metni ve bağlanma ekranı bunu söyler. Instagram organik için Faz 4'te verilen "sayı saklamama" kararı değişmez. _(Önerilen)_
4. **Grant paylaşımı (GK5).** Aynı workspace'te aynı Google hesabı için tek refresh token; başka bir projeye "Use existing connection" ile OWNER/ADMIN bağlar. _(Önerilen)_
5. **Roller (GK6).** Connect her üye; mülk değiştirme, Disconnect, veri silme ve grant paylaşımı yalnız OWNER/ADMIN. _(Önerilen)_
6. **Doğrulama (GK12).** GA-F1 canlıya çıkar çıkmaz tek bir Google doğrulamasına başvurulsun (`analytics.readonly` ve `webmasters.readonly` aynı başvuruda). Doğrulanmamış uygulamada Cloud projesinin **ömrü boyunca** en fazla 100 yeni kullanıcı bağlanabiliyor ve bu sayı sıfırlanamıyor. _(Önerilen)_
7. **Uyarı tablosu ve kanalı (GK7, GK8).** Meta Ads uygulaması `AdsAlert` tablosunu kurdu (6 Ekim, commit'siz migration `20261006140000_add_ads_mirror_and_alerts`); tablo yeterince genel (`adsAccountId` ve `externalId` boş olabilir, `kind` serbest metin, `@@unique([projectId, dedupeKey])`). GA ve Search Console uyarıları da bu tabloya yazılsın; ayrı bir migration'la boş olabilen bir `source` kolonu (`GA4` / `GSC` / `SEO`; boşsa Meta) eklensin. Kritik uyarı uygulama içinde ve sayı içermeyen bir Telegram mesajıyla iletilsin. _(Önerilen)_

---

## 1. Hedef davranış: "AI web analitik uzmanı"

### 1.1 Profesyonel rutin

| Ritim                                                          | AI uzmanı ne yapar                                                                                                                                                                                               | Çıktı                                                     | İnsan ne yapar                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------ |
| **Sürekli** (saatlik, mülk saatiyle 08:00-22:00)               | Yalnız şüphe varsa (dünkü veri düşük ya da gelmedi) realtime nabzı: son 30 dakikada aktif kullanıcı var mı. Ayrıca senkron ve token nabzı                                                                        | Uyarı (yalnız sorun varsa)                                | Kritik uyarıda bakar           |
| **Günlük** (dünkü veri hazır olunca, mülk saatiyle ~16:00)     | Dünü ve son 7 günü ambara çeker (geç veri), 12 günlük atıf penceresini tazeler. Veri akışı, key event, Unassigned, self-referral ve PII kontrolleri; KPI anomalileri                                             | "Website pulse" kartı (yalnız not edilecek bir şey varsa) | Bir dakikada okur              |
| **Haftalık** (Pazartesi 08:00, proje saati)                    | WoW ve YoY karşılaştırma; kanal ve sayfa ayrıştırması; açılış sayfası ve kanal kalitesi; AI asistan trafiği; site içi arama; Agentelse'in katkısı; reklam çapraz kontrolü; olgunlaşan önerilerin değerlendirmesi | Haftalık rapor + en fazla 3 öneri                         | Önerileri kabul ya da ret eder |
| **Aylık** (ayın 2'si 08:00; ayın son günü de kesinleşsin diye) | Ay raporu (ajansta müşteri raporu), hedeflerin durumu, gelecek ayın hedef önerisi ve tahmini. Yapılandırma denetimi: key event'ler, saklama, bağlantılar, alan adı eşleşmesi                                     | Aylık rapor + "Next month plan" kartı                     | Hedefleri onaylar              |
| **Çeyreklik**                                                  | Ölçüm planı gözden geçirme (olay şeması, key event seçimi), UTM yönetişimi, kanal stratejisi                                                                                                                     | Ölçüm planı önerisi                                       | Onaylar                        |
| **Platform** (operatör)                                        | Google API hata oranı, kota olayları, senkron gecikmesi, doğrulama durumu, Data API değişiklik günlüğü (ör. `deprecatedApiNames`)                                                                                | Operatör özeti (/health)                                  | Sahip izler                    |

### 1.2 Otonomi

GA4 entegrasyonu varsayılan olarak **salt okunurdur**; Agentelse GA'da hiçbir şeyi değiştirmez.

| Seviye (UI)                   | Ne yapılır                                                                                            | Asla yapılmaz                                                | Önkoşul                                                                | Varsayılan           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------- |
| **Read & suggest**            | Okuma, denetim, analiz, rapor ve öneri. Düzeltmeler adım adım rehberle kullanıcıya bırakılır          | GA yapılandırmasına yazma                                    | —                                                                      | **Evet**             |
| **Fix with approval** (GA-F7) | Key event işaretleme, saklama süresini 14 aya çıkarma, "AI assistants" kanal grubu, Agentelse notları | Onaysız değişiklik; veri silme; kullanıcı ve erişim yönetimi | `analytics.edit` izni (ayrı onay), OWNER/ADMIN onayı, değişiklik kaydı | Hayır (isteğe bağlı) |

Otomatik (onaysız) GA yazması hiçbir seviyede yoktur: GA yapılandırması bir kez bozulursa geçmiş veri geri gelmez.

### 1.3 Tasarım ilkeleri

- **Önce ölçüm, sonra yorum.** Ölçüm sağlığı FAIL olan bir dönemle ilgili kesin cümle kurulmaz.
- **Dürüst sayı.** Toplamlar her zaman ayrı bir toplam sorgusundan gelir. Kırılım satırları toplanarak toplam yazılmaz, çünkü (other) satırı ve eşikleme yüzünden tutmaz.
- **Her sayı bağlamıyla.** Dönem, mülk saat dilimi ve tazelik birlikte yazılır, ör. "Oct 1–7 · Property time (Europe/Skopje) · Data through Oct 5". Ön veri "Preliminary" etiketiyle gösterilir. Key event'leri kanala ya da kaynağa bölen tablolarda mülkün atıf modeli yazılır.
- **Küçük veride kesin dil yok.** İstatistik kapısını geçmeyen sonuç "directional" etiketi taşır (§6.3).
- **KOBİ varsayılanı.** Altı KPI: Users, Sessions, Engagement rate, Key events, Key event rate, Revenue (yalnız e-ticarette). Uzman metrikleri "More metrics" altındadır.
- **Kişisel veri yok.** Yalnız toplulaştırılmış veri okunur. Demografik ve kitle boyutları istenmez (bu, eşikleme kotasını da korur). Sayfa yolları saklanmadan ve LLM'e gitmeden önce PII süzgecinden geçer.
- **Maliyet bilinci.** Analiz kodda çalışır. LLM proje başına haftada ve ayda birer kez, sohbette de istek üzerine çalışır.
- **Mevcut UI kuralları.** Arayüz İngilizce; tek tarih/saat seçici (`src/components/ui/date-time-picker.tsx`); yeni dok ikonu yok; kartlar yerinde değişir.
- **Rapor dili.** Arayüz İngilizcedir; rapor ve özet metinleri ise projenin içerik dilinde yazılır (`brandRuleLanguageOf`; ör. Türkçe ya da Makedonca müşteri raporu). Sayılar o dilin biçimiyle yazılır. `number-check` TR ve EN ayraçlarını zaten kabul ediyor (`number-check.ts:9-13`); başka diller için biçim testleri eklenir (GK17).
- **AI bütçesi dolarsa.** Günlük AI sınırı dolduğunda (`BUDGET_EXCEEDED`) nabız ve raporlar yine zamanında çıkar, yalnız AI özeti olmadan: sayılar ve kural cümleleriyle ("AI summary skipped: daily AI limit reached"). Hiçbir rapor AI yüzünden gecikmez ya da kaybolmaz.
- **Erişilebilirlik.** Her grafiğin tablo karşılığı vardır; renk tek başına anlam taşımaz (artış/azalış oku ve işaret de vardır); sayfalar klavyeyle gezilebilir.

### 1.4 Başarı ölçütleri

| Ölçüt                                                     | Hedef                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| Ambar doğruluğu: kesinleşmiş günün toplamı GA4 arayüzüyle | ±%1 (eşikleme yoksa)                                                |
| Dünkü verinin ambara girişi                               | Günlerin %95'inde mülk saatiyle 18:00'e kadar                       |
| İzleme kırığının tespiti                                  | ≤ 26 saat (ertesi gün); realtime doğrulamasıyla gün içinde ≤ 3 saat |
| Yanlış kritik uyarı oranı                                 | < %10 (sahibin aylık örneklemi)                                     |
| Google API hata oranı (son 500 çağrı)                     | < %2                                                                |
| Mülk başına günlük kota kullanımı                         | < %2 (geri doldurma gününde < %10)                                  |
| Raporlarda doğrulanmamış sayı                             | 0 (number-check)                                                    |
| Önerilerin kabul oranı (gölge modda ölçülür)              | ≥ %50                                                               |
| Bağlantı sorununun kullanıcıya görünmesi                  | ≤ 24 saat                                                           |
| Analytics modül raporunun derlenmesi                      | < 3 sn (bugün 10-60 sn)                                             |

---

## 2. Mevcut durum ve boşluk analizi

### 2.1 Bileşen envanteri: korunacak, yeniden düzenlenecek, kaldırılacak

| Bileşen                                                                                                             | Bugün                                                                                                                                                              | Karar                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/integrations/google-client.ts`                                                                          | OAuth + Admin + Data + Search Console tek dosyada; düz `fetch`, SDK yok. Tek 8 sn zaman aşımı (`:18`), tekrar yok; token yanıtındaki `scope` atılıyor (`:180-209`) | **Yeniden düzenle.** Ortak çekirdek `src/server/integrations/google/*`, GA istemcisi `src/server/integrations/google-analytics/*` olur. Bu dosya geçiş boyunca ince bir uyumluluk katmanı olarak kalır, son tüketici taşınınca silinir |
| `google-token.ts`                                                                                                   | Her kullanımda refresh; `invalid_grant` → EXPIRED (`:16-36`)                                                                                                       | **Korunur ve genişler:** grant'ten okur, access token'ı önbelleğe alır, REVOKED'ı tanır                                                                                                                                                |
| `google-connections.ts` (`findActiveGoogleConnections`, `:26-50`)                                                   | Analytics ve SEO modülünün ortak çözücüsü                                                                                                                          | Korunur; GA tarafında `GaPropertyLink`'i de döndürür                                                                                                                                                                                   |
| `app/api/integrations/google/{start,callback}`                                                                      | State + oturum + proje erişimi doğru; `prompt=consent`, `include_granted_scopes` yok                                                                               | Korunur. PKCE, izin doğrulama, Google kimliği (`id`), grant upsert ve okunabilir `state_invalid` yönlendirmesi eklenir                                                                                                                 |
| `src/server/actions/google-actions.ts`                                                                              | Mülk seçimi, test, liste yenileme, Disconnect                                                                                                                      | Korunur. REVOKED koruması (GA-F0), rol, akıllı iptal, veri silme ve "Use existing connection" eklenir                                                                                                                                  |
| Integrations sayfası `GoogleTile` / `GoogleDialog` (`integrations/page.tsx:882-1090`)                               | Connected / Needs reconnection / Not connected; mülk seçimi, Test, Disconnect                                                                                      | Korunur. İzin eksikliği, mülk bilgileri (saat dilimi, para birimi, ölçüm kimliği, akış adresi), alan adı uyarısı, veri tazeliği ve ölçüm puanı eklenir                                                                                 |
| `src/server/modules/analytics/google.ts`                                                                            | İkinci bir `runReport` (6 metrik, "yesterday"e kadar); `googleFailReason` (`:55-69`)                                                                               | Ambara bağlanır; canlı yol yalnız ambar henüz dolmamışken kalır. `googleFailReason` çekirdeğin hata kataloğuna taşınır                                                                                                                 |
| `GoogleApiProvider` (`ANALYTICS_ANALYSIS`, 28 gün)                                                                  | Sonuç süreç içi `Map`'te (`:39`); sağlık anahtarı tüm kiracılar için tek `google-api` (`:42`)                                                                      | Ambardan okur ve `Map` kalkar. Sağlık anahtarı `google-analytics` olur; kiracı hataları global sağlığı düşürmez                                                                                                                        |
| `google-analytics-scanner.ts` + `seo-rules.ts`                                                                      | Günlük tarayıcı: GA'da örtüşen 7 günlük pencere, ±%20; GSC'de ilk 25 sorgu                                                                                         | GA kısmı (`DECLINING_TRAFFIC`) GA-F4'te `ga-analyze` ile değiştirilir ve kaldırılır. GSC kısmı Search Console planına geçer                                                                                                            |
| Analytics modül kartı (`src/lib/module-flows/analytics/*`, `analytics-flow-actions.ts`)                             | Brief → Plan → Create → Review → Share; kaynaklar paralel ve canlı okunuyor; `number-check` sağlam                                                                 | **Korunur ve genişler:** GA bölümleri (kanallar, açılış sayfaları, key event'ler, AI asistanları, Agentelse katkısı) ambardan anında derlenir. Yeni metrikler `METRIC_DEFS`'e (`report.ts:30-85`) eklenir                              |
| `number-check.ts` (`:47-113`)                                                                                       | Rapordaki sayıya dayanmayan cümleyi atıyor                                                                                                                         | **Korunur.** GA'nın bütün LLM anlatımları buradan geçer                                                                                                                                                                                |
| Brand Brain zinciri (`SignalUniverse` → Insight → Opportunity → Idea), `ProjectGoal`, `BrandLearning`, `IdeaEngine` | Sağlam; `ProjectGoal.currentValue` hiçbir kodda yazılmıyor                                                                                                         | Korunur; GA bulguları, hedef değerleri ve öğrenmelerle beslenir                                                                                                                                                                        |
| `src/server/security/safe-fetch.ts`                                                                                 | SSRF korumalı fetch                                                                                                                                                | Site etiketi tespiti için kullanılır (GA-F3)                                                                                                                                                                                           |
| `error-classifier.ts`, `provider-health.service.ts`                                                                 | Metin regex'i; 403 → AUTH; global sağlık                                                                                                                           | Google hataları kod, durum ve `reason` ile sınıflanır; kiracı hataları global sağlığı düşürmez                                                                                                                                         |
| Bağlı hesaplar kartı (`server/integrations/connected-accounts.ts`, `brand-overview-cards.tsx:288-330`)              | EXPIRED "off" görünüyor; metin Türkçe                                                                                                                              | EXPIRED "Needs reconnect" olur; metin İngilizceye çevrilir                                                                                                                                                                             |
| `src/app/privacy/page.tsx`, `src/app/data-deletion/page.tsx`                                                        | Google bölümü ve Limited Use beyanı yok                                                                                                                            | Google bölümü, Limited Use cümlesi ve silme yolu eklenir (GA-F1)                                                                                                                                                                       |

### 2.2 Boşluk tablosu

| #   | Boşluk                                          | Önem               | Kanıt                                                                                                                                                                                                                | Etki                                                                                                                                     | Faz           |
| --- | ----------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | Koparılmış bağlantı yeniden ACTIVE olabiliyor   | Yüksek             | `testGoogleConnectionAction` ve `refreshGoogleListsAction` REVOKED'ı kontrol etmeden `status: "ACTIVE"` yazıyor (`google-actions.ts:203-206`, `:255-258`). Disconnect token'ı silmediği için refresh başarılı oluyor | Kullanıcının kopardığı erişim sessizce geri gelir                                                                                        | GA-F0         |
| 2   | Verilen izin doğrulanmıyor                      | Yüksek             | `exchangeGoogleAuthCode` `scope` alanını atıyor (`google-client.ts:180-209`); callback koşulsuz ACTIVE yazıyor                                                                                                       | Google, e-posta + bir veri izni istendiğinde onay kutusu gösterir. Kutu kaldırılırsa bağlantı "Connected" görünür ama her çağrı 403 alır | GA-F1         |
| 3   | Disconnect token'ı tutuyor; Google'da iptal yok | Yüksek             | `disconnectGoogleAction` yalnız `status: "REVOKED"` yazıyor (`google-actions.ts:267-297`)                                                                                                                            | Limited Use ve silme taahhüdü karşılanmıyor; doğrulamada sorun çıkar                                                                     | GA-F1         |
| 4   | Eski satırlar ortak token taşıyor               | Yüksek             | `20260929000000_split_google_integration`: `_ga` ve `_gsc` satırları aynı `encryptedSecret`'ı (iki izinli) paylaşıyor                                                                                                | "Ayrı entegrasyon" Google tarafında yok; birinin iptali ikisini koparır                                                                  | GA-F1         |
| 5   | 100 refresh token sınırı                        | Yüksek (ajans)     | Her bağlantı `prompt=consent` ile yeni token üretiyor (`google-client.ts:161-178`)                                                                                                                                   | Aynı Google hesabıyla 100'den fazla bağlantıda en eski bağlantılar uyarısız düşer                                                        | GA-F1         |
| 6   | Global sağlık kiracılar arası                   | Yüksek             | Sağlık anahtarı tek `google-api` (`google-api-provider.ts:42`); "Google API error (HTTP 403)" mesajı AUTH regex'ine düşüyor (`error-classifier.ts:62-75`)                                                            | Bir müşterinin izin hatası herkesin `ANALYTICS_ANALYSIS` görevini durdurabilir                                                           | GA-F1         |
| 7   | Rol kontrolü yok                                | Orta               | `requireProjectAccess` rol bakmıyor (`tenant-context.ts:55-105`)                                                                                                                                                     | Her üye bağlantıyı koparabilir, mülkü değiştirebilir                                                                                     | GA-F1         |
| 8   | Veri saklanmıyor; metrikler sığ                 | Yüksek             | `fetchGa4Report` 2 metrik (`google-client.ts:315-338`); modül 6 metrik (`modules/analytics/google.ts:36-43`); `previousAnalyticsSnapshot` tek derinlik                                                               | Trend, kanal, sayfa, key event, rapor ve hedef takibi yok                                                                                | GA-F2         |
| 9   | Üç ayrı `runReport`, tutarsız dönem             | Orta               | `fetchGa4Report` "today"e kadar (`google-client.ts:329`); modül "yesterday"e kadar (`google.ts:88`); sağlayıcı 28 gün                                                                                                | Aynı dönem iki ekranda farklı sayı gösterir                                                                                              | GA-F2         |
| 10  | Tekrar, kota ve sunucu hatası yönetimi yok      | Orta               | Tek deneme, 8 sn; `returnPropertyQuota` kullanılmıyor                                                                                                                                                                | Geçici hata kalıcı başarısızlık olur. Mülk başına saatte 10 sunucu hatası aşılırsa Google o proje↔mülk çiftini bloklar                   | GA-F2         |
| 11  | Mülk ↔ proje alan adı bağı yok                  | Orta               | `Project.domain` (`schema.prisma:845`) seçili mülkün akış adresiyle karşılaştırılmıyor                                                                                                                               | Yanlış mülk seçilebilir                                                                                                                  | GA-F2 / GA-F3 |
| 12  | Ölçüm sağlığı denetimi yok                      | Yüksek             | Hiçbir kontrol yok                                                                                                                                                                                                   | İzleme kırığı haftalarca fark edilmez; yanlış veriyle karar verilir                                                                      | GA-F3         |
| 13  | Tarayıcı karşılaştırması gürültülü              | Yüksek             | Tarama-tarama, örtüşen 7 günlük pencere, sabit −%20 (`seo-rules.ts:16-46`)                                                                                                                                           | Haftanın günü etkisiyle yanlış "düşüş"; gerçek düşüş kaçabilir                                                                           | GA-F4         |
| 14  | Bulgu bir kez üretiliyor                        | Yüksek             | `externalRef` tarihsiz (`google-analytics-scanner.ts:170`); Signal parmak izi proje başına benzersiz                                                                                                                 | İkinci düşüş hiçbir zaman sinyal üretmez                                                                                                 | GA-F4         |
| 15  | Sohbet GA sayısı okuyamıyor                     | Orta               | Analytics sohbetinde GA aracı yok (`tools.ts:2037-2088`); tek yol `create_task ANALYTICS_ANALYSIS`                                                                                                                   | "Leads neden düştü?" yanıtlanamaz                                                                                                        | GA-F4         |
| 16  | `ProjectGoal.currentValue` hiç yazılmıyor       | Orta               | Yalnız gösteriliyor (`goals-section.tsx:146-150`)                                                                                                                                                                    | Hedef takibi yok                                                                                                                         | GA-F5         |
| 17  | Rapor derlemesi yavaş ve arşivsiz               | Orta               | Tek Server Action'da 10-60 sn; rapor yalnız kart verisinde (`docs/modules.md:73`)                                                                                                                                    | Kötü deneyim; geçmiş rapor yok                                                                                                           | GA-F2 / GA-F5 |
| 18  | UTM yok                                         | Yüksek             | Repo genelinde `utm_` ve `url_tags` yalnız bir test fikstüründe; reklam linkleri `link_data.link` (`meta-client.ts:1872-1995`)                                                                                       | Agentelse'in etkisi GA4'te görünmez                                                                                                      | GA-F6         |
| 19  | Gizlilik metninde Google yok                    | Yüksek (doğrulama) | `privacy/page.tsx:102-115` genel metin; Limited Use cümlesi yok                                                                                                                                                      | Google doğrulaması reddedilebilir                                                                                                        | GA-F1         |
| 20  | Odak ayarı izlemeyi de kapatıyor                | Düşük              | `AGENCY_FOCUS=social_ads` tarama adımını kapatıyor (`agency-focus.ts:64-69`)                                                                                                                                         | Ölçüm kırığı fark edilmez                                                                                                                | GA-F2         |
| 21  | `state_invalid` sessiz                          | Düşük              | Callback `/dashboard?googleError=state_invalid`'e gidiyor, dashboard bu parametreyi okumuyor (`callback/route.ts:83-85`)                                                                                             | Kullanıcı neden bağlanamadığını görmez                                                                                                   | GA-F1         |
| 22  | Kritik yollarda test yok                        | Orta               | Hata ayrıştırma ve token akışı testsiz; yalnız kapsam izolasyonu testi var                                                                                                                                           | Sessiz regresyon                                                                                                                         | Her faz       |

### 2.3 Analytics modülü açık kalanlarının karşılığı (`docs/modules.md:73`)

| Açık kalan                                | Plandaki karşılığı                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Rapor Outputs'a kaydedilmiyor             | GA-F5: haftalık ve aylık rapor kartları sohbette kalıcıdır (saklanan kart); "Website" sayfasında rapor arşivi |
| Derleme tek Server Action'da 10-60 sn     | GA-F2: GA bölümü ambardan < 1 sn'de derlenir; canlı okuma yalnız ambar boşken                                 |
| Mock modda özet yok                       | Değişmez                                                                                                      |
| GA4 metrik adları canlı hesapta denenmedi | GA-F2: sözleşme fikstürleri + sahibin mülkünde uçtan uca deneme; adlar `getMetadata` ile doğrulanır           |

---

## 3. Hedef mimari

### 3.0 Katmanlar ve veri akışı

```
[Arayüz]  Integrations → Google Analytics · "Website" sayfası · Brand sekmesi "Website" kartı
          · Analytics modül kartı · "Website analytics" sohbeti (nabız, rapor, uyarı) · Works "Needs attention" · /health
     │ server action / sohbet aracı                                   ▲ okuma (ambar)
     ▼                                                                │
[Motorlar]  Ölçüm sağlığı (GA-F3) ─uyarı─▶ MonitorAlert     Analiz (GA-F4) ─bulgu─▶ GaFinding
            Raporlama + planlama (GA-F5)                    Kapalı döngü + reklam ölçümü (GA-F6)
     │                                                                ▲
     ▼                                                                │
[Ürün döngüsü]  Signal → Insight → Opportunity → Idea · ProjectGoal · BrandLearning
                · Meta AdsDecision kanıtı · Search Console köprüsü (§12)
     ▲
[Ambar]  GaPropertyLink · GaDailyTotal · GaReportSlice · GaMonthlySummary · GaHealthCheck · TrackedLink
     ▲
[Senkron (GA-F2)]  rapor kataloğu · geri doldurma · 7/13 günlük revizyon · kalite bayrakları · kota yöneticisi
     ▲
[GA istemcisi]  Data API v1beta (runReport, batchRunReports, runRealtimeReport, getMetadata, checkCompatibility)
                · Admin API v1beta (+ seçili v1alpha uçları)
     ▲
[Google çekirdeği, ortak kod]  OAuth (PKCE, izin, kimlik, refresh, revoke) · GoogleGrant · access token önbelleği
                               · HTTP (zaman aşımı, güvenli tekrar) · hata kataloğu · PII süzgeci
     ▲
[Google]  analyticsdata.googleapis.com · analyticsadmin.googleapis.com · oauth2.googleapis.com
```

**Analiz karar akışı:**

```
GA4 ──(günlük senkron + 7/13 günlük revizyon)──▶ Ambar
                                                   ▼
                    Kalite kapısı: tazelik, eşikleme, (other), ölçüm sağlığı
                    (kritik ölçüm sorunu olan günler tabandan çıkar, "suspect" olur)
                                                   ▼
                    Özellikler: haftanın günü tabanı, pencereler, oranlar, hedefler
                       ┌───────────────────────────┴────────────────────────┐
                       ▼                                                    ▼
          Ölçüm kontrolleri (MH, günlük)                     Analiz kuralları (AN, günlük + haftalık)
                       ▼                                                    ▼
          MonitorAlert (tekilleşir, kendiliğinden kapanır)   GaFinding adayı → istatistik kapısı
                                                                            ▼
                                       AI: açıklama + önceliklendirme (sayı üretemez; number-check)
                                                                            ▼
                    Yüzey: nabız kartı · haftalık/aylık rapor · sohbet · Brand Brain sinyali · fikir havuzu
                                                                            ▼
                    Kullanıcı: Accept → eylem (içerik, reklam, düzeltme) → 28 gün sonra değerlendirme
                                                                            ▼
                                             BrandLearning (kapıyı geçerse) · Meta ve SEO kanıtı
```

### 3.1 Google erişim çekirdeği (ortak kod; Search Console planı §3.1 ile aynı)

Bu katman bir entegrasyon değil, iki entegrasyonun kullandığı kütüphanedir. Hangi plan önce uygulanırsa o yazar.

**Yeni dosyalar** (`src/server/integrations/google/`):

- `version.ts`: uç adresleri ve sürümler tek yerde (`analyticsdata v1beta`, `analyticsadmin v1beta/v1alpha`, `searchconsole`, `oauth2`).
- `oauth.ts`: yetkilendirme adresi (PKCE S256; doğrulayıcı imzalı state'te taşınır, TikTok/X'teki `pkce.ts` deseni), kod değişimi (`grantedScopes` dahil), refresh, revoke, `tokeninfo` ile izin kontrolü, `userinfo` ile Google kimliği (`id`, `email`).
- `grant.ts`: `GoogleGrant` okuma/yazma; refresh token'ın tek kaynağı.
- `access-token.ts`: süreç içi önbellek (grant başına; bitişten 5 dk önce yenilenir; tek uçuş). Token loglara asla yazılmaz.
- `revoke-policy.ts`: "Google'da iptal güvenli mi?" kararı (saf fonksiyon + sorgu; §3.2).
- `http.ts`: `googleRequest({ url, method, body, kind, lane })`. Zaman aşımları işe göre ayrılır: token 10 sn, Admin 15 sn, rapor 30 sn (bugün hepsi 8 sn). Yalnız TRANSIENT okumalar tekrar edilir (2 sn / 8 sn, ±%25 jitter, en çok 2 tekrar); `Retry-After` dikkate alınır.
- `errors.ts`, `error-catalog.ts`: Google hata zarfının (`error.code`, `error.status`, `error.details[]` içindeki `ErrorInfo.reason`) ve OAuth hatalarının (`invalid_grant`, `error_subtype`) sınıflanması.
- `pii.ts`: e-posta, telefon, uzun rakam dizileri ve bilinen hassas parametreler (`email`, `phone`, `tel`, `name`, `token`, `key`, `code`, `session`) için maskeleme; `gclid`, `fbclid` ve `utm_*` gibi izleme parametrelerinin normalleştirilmesi.
- `__fixtures__/`: kayıtlı yanıtlar (sürüm klasörleriyle).

**Hata taksonomisi** (karar kod, durum ve `reason` ile verilir; mesaj metniyle değil):

| Sınıf         | Google işareti                                                      | Otomatik eylem                                                                                                                                            | Kullanıcı mesajı (UI)                                                                            |
| ------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| TRANSIENT     | Ağ hatası, zaman aşımı, 502/504, `UNAVAILABLE`, `DEADLINE_EXCEEDED` | Okumada en çok 2 tekrar; sonra iş ertelenir                                                                                                               | Gösterilmez. Sürerse: "Google Analytics is having a temporary problem. We'll try again shortly." |
| SERVER_ERROR  | 500 / 503 (`INTERNAL`)                                              | **En çok 1 tekrar.** Mülk başına saatlik sayaç tutulur; 3'e ulaşınca o saat P2 durur (Google sınırı proje↔mülk başına saatte 10; aşılırsa çift bloklanır) | Gösterilmez                                                                                      |
| RATE_LIMIT    | 429 `RESOURCE_EXHAUSTED` (saatlik token, eşzamanlı istek)           | Mülk `rateLimitedUntil` = saat sonu (eşzamanlıda 60 sn); P1 dışındaki her şey bekler                                                                      | "Google asked us to slow down. Updates resume at 15:00."                                         |
| QUOTA_DAILY   | 429 + günlük token kotası                                           | P2 o gün durur (günlük kota gece yarısı PST'de sıfırlanır)                                                                                                | "Daily Google Analytics limit reached. Data refreshes tomorrow."                                 |
| AUTH          | Refresh'te `invalid_grant`; 401 `UNAUTHENTICATED`                   | Grant ve ona bağlı tüm GA bağlantıları EXPIRED olur; senkron durur; uyarı açılır                                                                          | "Reconnect Google Analytics: access expired or was removed."                                     |
| SCOPE_MISSING | 403 + `ACCESS_TOKEN_SCOPE_INSUFFICIENT`; `tokeninfo`'da izin yok    | Bağlantı NEEDS_PERMISSION; senkron durur                                                                                                                  | "Agentelse needs permission to read Google Analytics. Reconnect and tick the box."               |
| PERMISSION    | 403 `PERMISSION_DENIED` (mülkte rol yok)                            | Bağlantı PROPERTY_ACCESS_LOST; mülk listesi yenilenir                                                                                                     | "Your Google account no longer has access to this property."                                     |
| NOT_FOUND     | 404                                                                 | Bağlantı PROPERTY_GONE                                                                                                                                    | "This GA4 property no longer exists."                                                            |
| VALIDATION    | 400 `INVALID_ARGUMENT` (uyumsuz boyut/metrik, kaldırılmış ad)       | Tekrar yok; katalog hatası operatöre                                                                                                                      | Gösterilmez                                                                                      |
| API_DISABLED  | 403 + `SERVICE_DISABLED` / `accessNotConfigured`                    | Operatöre CRITICAL (bizim Cloud ayarımız)                                                                                                                 | "Google Analytics is temporarily unavailable in Agentelse."                                      |
| UNKNOWN       | Diğerleri                                                           | Tekrar yok; kayıt; tekrarlarsa operatör uyarısı                                                                                                           | "Something went wrong at Google (ref: …)."                                                       |

**Devre kesici:**

- AUTH, SCOPE_MISSING, PERMISSION ve NOT_FOUND yalnız ilgili grant'te ya da bağlantıda kalır; global sağlığı düşürmez.
- Global `google-analytics` sağlığını yalnız TRANSIENT/SERVER_ERROR yoğunluğu ve API_DISABLED etkiler.
- `ProviderHealth` anahtarı `google-api` yerine `google-analytics` ve `google-search-console` olarak ayrılır.
- Google, proje↔mülk başına 15 dakikada 10.000 istemci hatasını (200 ve 500 dışındaki her yanıt) aşan projeyi geçici olarak bloklar. VALIDATION hatasında kör tekrar yapılmaması bu yüzden şarttır.

Kısa arayüz taslağı:

```ts
type GoogleService = "analytics" | "search_console";
type Lane = "P1_USER" | "P2_BACKGROUND";
type GoogleErrorClass =
  | "TRANSIENT"
  | "SERVER_ERROR"
  | "RATE_LIMIT"
  | "QUOTA_DAILY"
  | "AUTH"
  | "SCOPE_MISSING"
  | "PERMISSION"
  | "NOT_FOUND"
  | "VALIDATION"
  | "API_DISABLED"
  | "UNKNOWN";

// Refresh token yalnız GoogleGrant'te; access token yalnız bellekte.
interface GoogleAccess {
  accessTokenFor(grantId: string): Promise<string>; // önbellekli, tek uçuş
  grantedScopes(grantId: string): Promise<string[]>; // tokeninfo, 24 sa önbellek
}
```

### 3.2 Bağlantı ve kimlik (GA-F1)

**Bağlanma akışı:**

1. "Connect Google Analytics" → Google onay ekranı: `analytics.readonly` + `userinfo.email`, `access_type=offline`, `prompt=consent select_account`, PKCE. `include_granted_scopes` gönderilmez (bugünkü karar korunur).
2. Callback: state, oturum kullanıcısı ve proje erişimi kontrol edilir (bugünkü kontroller korunur), ardından kod değişimi yapılır.
3. **İzin doğrulaması:** Token yanıtındaki `scope` alanında `analytics.readonly` yoksa bağlantı oluşturulmaz ve `googleError=scope_missing` ile dönülür: "You didn't allow access to Google Analytics. Connect again and tick the box." (Google, bir giriş izni + bir veri izni istendiğinde onay kutuları gösterir. Tek veri izni tek başına istenseydi "hep ya da hiç" olurdu, ama hesabı tanımak için e-posta gerekiyor.)
4. **Kimlik:** `userinfo` → Google hesap kimliği (`id`) ve e-posta.
5. **Grant upsert:** `GoogleGrant` (workspace, servis, Google kimliği) zaten varsa refresh token yenisiyle değiştirilir. Eski token **iptal edilmez**, çünkü Google iptali bütün grant'e uygular ve yeni token da ölürdü.
6. Bağlantı (`IntegrationCredential`, proje × `google_analytics`) grant'e bağlanır; `encryptedSecret` boş kalır (yeni satırlarda tek kaynak grant'tir).
7. **Mülk listesi:** `accountSummaries.list` sayfalı okunur (`pageSize=200` + `nextPageToken`; bugün sayfalanmıyor). Proje alan adıyla eşleşen akış adresi olan mülk önerilir. Seçimde akış adresi `Project.domain` ile uyuşmazsa uyarı gösterilir: "This property tracks shop.example.com, but this project's website is example.com."

**Grant modeli ve 100 token sınırı.** Google'ın kuralı: "Google hesabı × OAuth istemcisi başına 100 refresh token; sınır aşılınca en eskisi uyarısız geçersiz olur." Bugün her proje bağlantısı yeni token üretiyor. Hedef:

- Aynı workspace'te aynı Google hesabı ve aynı servis için **tek** `GoogleGrant` ve tek refresh token.
- Başka bir projeye bağlarken diyalog önce "Use x@agency.com (connected in Project A)" seçeneğini gösterir; OAuth'a gitmeden aynı grant bağlanır. Bu yalnız OWNER/ADMIN'e açıktır ve AuditLog'a yazılır.
- Böylece bir Google hesabının canlı token sayısı yaklaşık olarak bağlı olduğu workspace × servis sayısına iner.

**Google'da iptal (akıllı iptal).** Google'da izin kaydı OAuth istemcisine değil **Cloud projesine** aittir: "İptal, projeye verilmiş bütün izinleri kaldırır ve projedeki tüm istemcilerin token'larını geçersiz kılar." Bu yüzden aynı Google hesabıyla bağlanmış GA ve Search Console, bizim tarafımızda ayrı olsalar da Google'da tek izin kaydını paylaşır. Kural (`revoke-policy.ts`):

- Disconnect bizim token'ımızı **her zaman** hemen siler.
- Google'da iptal (`oauth2.googleapis.com/revoke`) yalnız tek bir durumda çağrılır: aynı Google kimliğine ait, **hangi workspace ya da servis olursa olsun**, başka aktif grant kalmamışsa.
- Kalmışsa kullanıcıya not gösterilir: "Agentelse still uses this Google account for Search Console, so we didn't remove its access in your Google Account."
- Kullanıcı Google hesabından Agentelse'i kaldırırsa iki servis birden düşer. Bu beklenen davranıştır ve `invalid_grant` ile algılanır.
- Sahip tek Cloud projesinde kalmayı seçti (GK1, 6 Ekim); ikinci proje ve ikinci Google doğrulaması yapılmaz. Bu yüzden akıllı iptal kuralı zorunludur ve testle sabitlenir.

**Eski ortak token'lar.** 29 Eylül migration'ının ürettiği `_ga` / `_gsc` çiftleri tek bir `GoogleGrant`'e (`service = "legacy_combined"`, iki izinli) tembel olarak taşınır ve iki bağlantı da çalışmaya devam eder. Biri koparılınca diğeri etkilenmez, çünkü iptal kuralı grant'e hâlâ başka bir bağlantının bağlı olduğunu görür. Integrations'ta isteğe bağlı bir not çıkar: "Reconnect to keep Google Analytics and Search Console fully separate."

**Token sağlığı** (`google-grant-health`, günlük + bağlanırken): refresh (önbellekli), `tokeninfo` ile izin kontrolü, seçili mülkün `accountSummaries` listesinde olup olmadığı. Durumlar `GaPropertyLink.health` alanında tutulur (enum migration'ı gerekmez): `OK`, `NEEDS_RECONNECT`, `NEEDS_PERMISSION`, `PROPERTY_ACCESS_LOST`, `PROPERTY_GONE`, `RATE_LIMITED`, `SYNC_FAILING`. `CredentialStatus` (ACTIVE / EXPIRED / REVOKED) kaba durum olarak kalır.

**Disconnect ve silme:**

- Yalnız OWNER/ADMIN yapabilir (`requireProjectRole`; `tenant-context.ts`'e yeni yardımcı).
- Token silinir. Grant'e başka bağlantı bağlı değilse grant de silinir ve akıllı iptal uygulanır. Bağlantı REVOKED olur.
- Ambar verisi 30 gün sonra `ga-retention` ile silinir; "Delete data now" hemen siler. 30 gün içinde yeniden bağlanan aynı mülk geçmişini korur.
- Kullanıcı Google hesabından iptal ederse bağlantı `invalid_grant` ile EXPIRED'a düşer; aynı 30 günlük kural uygulanır.
- **REVOKED koruması (GA-F0):** OAuth callback dışındaki hiçbir yol REVOKED bir bağlantıyı ACTIVE yapamaz.

### 3.3 Senkron ve ambar (GA-F2)

**Yeni dosyalar:** `src/server/integrations/google-analytics/{data-api,admin-api,realtime,catalog,governor,fields}.ts`; `src/server/website-analytics/sync/{runner,metadata,daily,revisions,backfill,intraday}.ts`; `src/server/website-analytics/store.ts` (okuyucuların tek kapısı). Saf yardımcılar (kalite bayrakları, kanal eşlemesi, biçim) `src/lib/website-analytics/` altında.

**Rapor kataloğu** (v1; demografik ve kitle boyutları bilinçli olarak yok):

| Anahtar                                                          | Boyutlar                                                                                  | Metrikler                                                                                                                                    | Satır sınırı                               | Tutma                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------- |
| `totals`                                                         | `date`                                                                                    | activeUsers, newUsers, sessions, engagedSessions, userEngagementDuration, screenPageViews, eventCount, keyEvents, totalRevenue, transactions | —                                          | Günlük (`GaDailyTotal`), 400 gün            |
| `channel`                                                        | `date`, `sessionDefaultChannelGroup`                                                      | sessions, engagedSessions, activeUsers, newUsers, keyEvents, totalRevenue                                                                    | Tümü                                       | Günlük, 400 gün                             |
| `source_medium`                                                  | `date`, `sessionSource`, `sessionMedium`                                                  | sessions, engagedSessions, keyEvents, totalRevenue                                                                                           | 250/gün                                    | Günlük 95 gün + haftalık 400 gün            |
| `campaign`                                                       | `date`, `sessionCampaignName`, `sessionSource`, `sessionMedium`, `sessionManualAdContent` | sessions, engagedSessions, keyEvents, totalRevenue                                                                                           | 250/gün (`(not set)` ve `(organic)` hariç) | Günlük 95 gün + haftalık 400 gün            |
| `landing_page`                                                   | `date`, `landingPage`                                                                     | sessions, engagedSessions, keyEvents, totalRevenue, userEngagementDuration                                                                   | 500/gün                                    | Günlük 95 gün + haftalık 400 gün            |
| `page`                                                           | `date`, `pagePath`, `pageTitle`                                                           | screenPageViews, activeUsers, userEngagementDuration                                                                                         | 500/gün                                    | Günlük 95 gün + haftalık 400 gün            |
| `events`                                                         | `date`, `eventName`, `isKeyEvent`                                                         | eventCount, keyEvents, totalUsers                                                                                                            | Tümü                                       | Günlük, 400 gün                             |
| `key_events_channel`                                             | `date`, `sessionDefaultChannelGroup`, `eventName` (süzgeç `isKeyEvent = "true"`)          | keyEvents, totalRevenue                                                                                                                      | Tümü                                       | Günlük, 400 gün                             |
| `attribution`                                                    | `date`, `defaultChannelGroup` (olay kapsamlı; mülkün atıf modeliyle)                      | keyEvents, totalRevenue                                                                                                                      | Tümü                                       | Günlük, 400 gün; son 13 gün her gün yeniden |
| `device_country`                                                 | `date`, `deviceCategory`, `country`                                                       | sessions, engagedSessions, keyEvents                                                                                                         | 100/gün                                    | Günlük 95 gün + haftalık 400 gün            |
| `new_returning`                                                  | `date`, `newVsReturning`                                                                  | activeUsers, sessions, keyEvents                                                                                                             | Tümü                                       | Günlük, 400 gün                             |
| `site_search`                                                    | `searchTerm` (haftalık aralık)                                                            | eventCount                                                                                                                                   | 200/hafta                                  | Haftalık, 400 gün                           |
| `google_ads` (yalnız mülke Google Ads bağlıysa)                  | `date`, `sessionGoogleAdsCampaignName`                                                    | advertiserAdCost, advertiserAdClicks, sessions, keyEvents, totalRevenue                                                                      | 100/gün                                    | Günlük, 400 gün                             |
| `search_console` (yalnız mülkün Search Console bağlantısı varsa) | `landingPagePlusQueryString` (28 günlük aralık)                                           | organicGoogleSearchClicks, organicGoogleSearchImpressions, organicGoogleSearchClickThroughRate, organicGoogleSearchAveragePosition           | 500                                        | Haftalık, 95 gün                            |

- Bir istekte en çok 9 boyut ve 10 metrik olabilir. `batchRunReports` aynı mülk için 5 isteği tek HTTP çağrısında toplar (token yine istek başına sayılır).
- Her istekte `returnPropertyQuota: true` ve `keepEmptyRows: false` gönderilir; sıralama ana metriğe göre azalandır; sayfalama `limit` + `offset` ile yapılır.
- Metrik ve boyut adları mülk başına haftada bir `getMetadata` ile doğrulanır. `deprecatedApiNames` görülürse operatör uyarılır (ör. eski `conversions` adı hâlâ kabul ediliyor ama kaldırılma tarihi yok).
- `google_ads` ve `search_console` raporları önce `checkCompatibility` ile denenir; uyumsuzsa katalogdan düşer. Admin API'de Search Console bağlantısını okuyan bir uç yoktur; bağlantı ancak bu yolla anlaşılır.
- `pagePath`, `landingPage` ve `pageTitle` değerleri saklanmadan önce `pii.ts`'ten geçer.

**Tazelik ve revizyon politikası.** Google'ın tarifi: işleme 24-48 saat sürebilir; standart mülkte önceki gün tipik olarak mülk saatiyle ~15:30'da raporlarda olur (garanti değil); geç veri 7 güne kadar gelebilir; key event atfı 12 güne kadar değişebilir. Buna göre:

- **Günlük çekim:** mülk saatiyle 16:00'dan sonra yapılır ve dünkü gün `preliminary` olarak yazılır. Veri gelmediyse 18:00 ve 21:00'de yeniden denenir.
- **Revizyon:** her gün, aynı istekte `date` boyutuyla D-1…D-7 aralığı yeniden çekilir (rapor başına tek istek). `attribution` raporu için aralık D-1…D-13'tür.
- **Kesinleşme:** D-8'den eski gün `isFinal` olur; `attribution` için D-13'ten eski gün.
- **Gün içi ("Today so far"):** yalnız "Website" sayfası açıkken ve en çok 2 saatte bir çekilir; saklanmaz ve "Partial" etiketiyle gösterilir (standart mülkte gün içi gecikme 2-6 saattir).
- **Realtime:** yalnız MH1 şüphesinde, mülk saatiyle 08:00-22:00 arasında saatte bir `runRealtimeReport` (`activeUsers`) çağrılır; realtime kotası ayrıdır.
- **Tarih anahtarı:** GA'nın `date` boyutu, yani **mülkün saat dilimindeki gün** (`@db.Date`). Mülk saat dilimi projeninkinden farklıysa UI etiketi gösterilir: "Property time (America/New_York)".

**Geri doldurma** (bağlanınca bir kez, P2 şeridinde):

- `totals`, `channel`, `events`, `key_events_channel`, `attribution` ve `new_returning` için 400 gün (ya da mülkün oluşturulma tarihinden itibaren) günlük veri.
- Yüksek kardinaliteli raporlar için 95 gün günlük + 400 gün `isoYearIsoWeek` boyutuyla haftalık veri.
- 90 günlük parçalar halinde çekilir; tahmini 60-90 istek ve 5-15 bin token (günlük kotanın %3-8'i). Saatlik kotanın %50'si aşılırsa iş sonraki saate bölünür.

**Kalite bayrakları** (her `GaReportSlice` ve `GaDailyTotal` satırında): `subjectToThresholding`, `dataLossFromOtherRow`, `samplingMetadatas` (varsa), `dataTruncationReasons` (2026'da eklendi: saklama tarihi, Google Ads 36 ay vb.), `emptyReason`, `timeZone`, `currencyCode`, `truncated` (satır sınırına ulaşıldı), `preliminary`.

**Kota yöneticisi** (`governor.ts`; durum DB'de, `GaPropertyLink.lastQuota` ve `rateLimitedUntil` alanlarında):

- Anahtar GA mülk kimliğidir; aynı mülk iki projeye bağlıysa da tek kova kullanılır.
- Her yanıttaki `propertyQuota` saklanır: `tokensPerDay`, `tokensPerHour`, `tokensPerProjectPerHour`, `concurrentRequests`, `serverErrorsPerProjectPerHour`, `potentiallyThresholdedRequestsPerHour` (her biri consumed/remaining).
- Saatlik kalan < %20 ise P2 sonraki saate kalır; günlük kalan < %10 ise P2 o gün durur. P1 (kullanıcının "Refresh"i, sohbetteki canlı sorgu) kalan > %5 iken çalışır.
- Eşzamanlılık mülk başına en çok 2 istektir (Google sınırı 10).
- Sunucu hatası: mülk başına saatte 3 hatadan sonra P2 durur (Google sınırı 10; aşılırsa proje↔mülk çifti bloklanır).

**Kilit ve hata durumu:**

- `GaPropertyLink.syncLeaseUntil` CAS ile 5 dakikalık kilit olarak alınır; tick başına en çok 3 bağlantı işlenir.
- Hata alan bağlantıda üstel geri çekilme uygulanır (5 dk → 6 sa); AUTH, SCOPE_MISSING ve PERMISSION'da senkron durur.
- Senkron proje durumundan bağımsızdır; ancak `PAUSED`/`ARCHIVED` projede yalnız sağlık kontrolleri çalışır, veri çekimi durur.
- `AGENCY_FOCUS` ayarı senkron ve sağlık adımlarını kapatmaz.

**Okuyucuların ambara geçişi** (`GA_SYNC=true` iken): Analytics modül kartının GA bölümü, `GoogleApiProvider`, Brand sekmesi kartı, sohbet araçları ve fikir motoru ambardan okur. Ambarda olmayan bir soru (ör. sohbette alışılmadık bir kırılım) P1 şeridinde canlı sorguya gider. Bayrak kapalıyken eski canlı yollar çalışır; geri dönüş bayrakla yapılır.

**Geliştirme ortamı:** Yerel ortam canlı DB'yi paylaştığı için yerelde senkron varsayılan olarak kapalıdır; yalnız `GA_SYNC_DEV_PROJECTS` listesindeki projeler senkronlanır. Böylece müşteri kotası ve verisi yerelden tüketilmez.

**Mock modu:** `AGENTELSE_PROVIDER_MODE=mock` iken (CI ve yerel geliştirme) GA istemcisi kayıtlı fikstürlerden okur; Google'a ve token uç noktasına hiçbir çağrı gitmez. Website sayfası, raporlar ve kurallar gerçek bir mülk olmadan geliştirilip test edilebilir. Mock verisi yazılırsa satırlar `isMock` ile işaretlenir (mevcut desen, ör. `ProjectGoal.isMock`) ve canlı raporlara karışmaz.

### 3.4 Veri kalitesi ve "dürüst sayı"

- **Toplamın kaynağı:** KPI'lar her zaman `totals` raporundan gelir. Kırılım tablolarının altında "Other / not shown" satırı = toplam − görünen satırlar.
- **Eşikleme:** Katalog demografik boyut içermediği için nadirdir. Görülürse tabloda not çıkar: "Google hid some small values to protect privacy."
- **(other) satırı:** Yüksek kardinaliteli boyutlarda (yaklaşık 500'ün üstünde değer) Google satırları "(other)" altında toplar. `dataLossFromOtherRow` true ise: "Some rows are grouped as (other) by Google." Kaynağı çoğunlukla kimlik taşıyan UTM'lerdir (MH19).
- **Ön veri:** Son 7 gün "Preliminary" (açık gri) gösterilir. Son 13 günün kanal bazlı key event'leri şu notu taşır: "May change as Google finalizes attribution."
- **Atıf:** Olay kapsamlı tablolar (key event'in hangi kanala yazıldığı) mülkün modeliyle hesaplanır (Data-driven, Paid and organic last click ya da Google paid channels last click) ve model değişince geriye dönük değişir. Oturum kapsamlı tablolar değişmez. İki tür tablo yan yana konmaz; her biri etiketlenir.
- **Şüpheli günler:** Kritik ölçüm uyarısı (MH1, MH4, MH6, MH20) açık olan günler anomali tabanlarından çıkarılır ve grafiklerde taranmış gösterilir. O günlere dayanan bulgu "suspect" olur ve rapora girmez.
- **Uzlaştırma bekçisi:** Günlük çalışır. `totals.sessions` ile `channel` toplamı arasındaki fark (eşikleme ve (other) yokken) %2'yi aşarsa operatöre SYNC_DATA_GAP uyarısı gider.
- **Biçim:** `src/lib/module-flows/analytics/format.ts` tek kaynaktır. Para mülkün para birimiyle, oranlar yüzde olarak, süreler dakika:saniye biçiminde gösterilir.

### 3.5 Ölçüm sağlığı denetimi (GA-F3)

**Yeni dosyalar** (`src/server/website-analytics/health/`): `checks.ts` (kayıt defteri), `admin-checks.ts`, `data-checks.ts`, `site-tag.ts`, `score.ts`, `guides.ts` (İngilizce düzeltme rehberleri).

- Her kontrol `PASS | WARN | FAIL | UNKNOWN`, bir kanıt (`evidence`) ve bir rehber kimliği döndürür; sonuç `GaHealthCheck`'e upsert edilir. Durum değişiminde `MonitorAlert` açılır ya da kapanır (§3.7'deki yönlendirme).
- **Kaynak türleri:** ADMIN (Admin API: key event'ler, saklama, akışlar, bağlantılar), DATA (ambardan; Google'a çağrı yok), SITE (`safe-fetch` ile sitenin kendisi), INTEGRATION (token, izin, kota, senkron).
- Kontrol listesi, eşikleri ve rehberleri §6.1'de (MH1-MH25).
- **Site etiketi tespiti** (`site-tag.ts`; haftalık + kullanıcı "I fixed it" dediğinde):
  - Ana sayfa ve en çok oturum alan 5 açılış sayfası `safe-fetch` ile okunur (UA `AgentelseSiteCheck/1.0 (+https://agentelse.com/bot)`).
  - Aranan: akışın `G-` ölçüm kimliği, `GTM-` kapsayıcısı, `gtag/js`, birden fazla `G-` kimliği, `gtag('consent','default'…)`.
  - Yalnız GTM bulunursa sonuç UNKNOWN olur: "Loaded through Google Tag Manager; we can't see the measurement ID from outside." Etiketin istemci tarafında sonradan yüklendiği sitelerde de sonuç UNKNOWN'dır.
  - Bu kontrol tek başına FAIL üretmez; veri kontrolleriyle birleşir.
- **Measurement health puanı** (0-100): Veri akışı 30, Yapılandırma 20, Atıf hijyeni 20, Gizlilik 15, Site etiketi 10, Diğer 5. Açık bir CRITICAL puanı en fazla 40'ta tutar. Puan Integrations diyaloğunda, "Website" sayfasında ve Brand kartında görünür.
- **Düzeltme rehberleri:** Her FAIL/WARN için 3-6 adımlık İngilizce bir rehber yazılır. Rehber GA4 arayüzündeki ilgili ekranın adını verir ("Admin → Data display → Key events") ve mümkünse doğrudan bağlantı içerir (bağlantı biçimleri doğrulanmalı). GA-F7 açıksa uygun olanlarda "Fix it for me (needs approval)" düğmesi çıkar.

### 3.6 Analiz motoru (GA-F4)

**Yeni dosyalar** (`src/server/website-analytics/analysis/`; hepsi saf ve testli): `baseline.ts` (haftanın günü düzeltilmiş medyan/MAD tabanı), `anomaly.ts`, `decompose.ts`, `landing-pages.ts`, `channels.ts`, `ai-referrals.ts`, `site-search.ts`, `content.ts`, `ecommerce.ts`, `campaigns.ts`, `stats.ts` (iki oran z-testi, Poisson ve Wilson aralıkları, Benjamini-Hochberg). Orkestrasyon `runner.ts`'tedir.

- Kurallar ve eşikler §6.2'de (AN1-AN16), istatistik kapıları §6.3'te.
- **Bulgu kaydı (`GaFinding`):**
  - Her aday bir kayıttır; parmak izi = kural + konu + **dönem** (ISO hafta ya da gün). Böylece aynı sorun her hafta yeniden değerlendirilir ve bugünkü "bir kez ve sonsuza dek" hatası kapanır.
  - Yaşam döngüsü: `OPEN → ACCEPTED | DISMISSED → DONE → EVALUATED`. Süresi dolan kayıt `EXPIRED`, yenisi gelen `SUPERSEDED` olur; ölçüm sorunu düzelince ilgili bulgu `RESOLVED` olur.
- **Etki tahmini:** Her fırsat "haftada kaç oturum, key event ya da gelir" cinsinden bir tahmin taşır, ör. "If this page converted at the site average: about +6 leads a week (directional)." Öncelik = etki × güven.
- **LLM:**
  - Haftalık raporda en çok 5 bulgu tek çağrıda açıklanır ve önceliklendirilir (`ReasoningService`, varsayılan seviye).
  - İsteme yalnız bulgu kanıtındaki sayılar ve PII süzgecinden geçmiş sayfa yolları gider; sonuç `number-check`'ten geçer.
  - LLM yeni bulgu ya da sayı üretemez.
- **Brand Brain'e akış:**
  - Yalnız stratejik bulgular (kanal kayması, kalıcı düşüş, AI trafiği artışı, güçlü açılış sayfası) `SignalUniverse.ingestRaw` ile sinyal olur.
  - Kategori mevcut enum'dan seçilir: sitenin kendisi için `PERFORMANCE`, organik arama için `SEO`.
  - `externalRef` tarihlidir: `ga:<linkId>:<rule>:<konu>:<isoHafta>`.
  - Günlük anomaliler sinyal olmaz (gürültü); uyarıda ve nabız kartında kalır.
- **Fikir havuzu:** Site içi arama terimleri (AN8), AI asistanlarının getirdiği konular (AN7) ve yüksek dönüşümlü sayfa konuları (AN3) `moduleRefillIfDue` üzerinden (`idea-modules.ts`) "website" kaynağı olarak fikir motoruna kanıtla gider (`source: "results"`, `evidence` ≤ 3). Model gerektirmeyen yol tercih edilir (`refreshAdIdeas` deseni).
- **Sohbet araçları** (`tools.ts`; Analytics modül sohbetinde ve "Website analytics" sohbetinde):
  - `get_website_overview`: KPI'lar, karşılaştırma, ölçüm puanı, tazelik.
  - `query_website_analytics`: izin listesindeki boyut ve metriklerle, en çok 400 günlük dönem. Önce ambar, gerekirse P1 canlı sorgu kullanılır; tablo ve kalite bayrakları döner.
  - `explain_website_change`: bir dönem için AN2 ayrıştırması.
  - `get_measurement_health`: açık kontroller ve rehberler.
  - Hepsi salt okunurdur ve `external: true` işaretlidir: referans kaynağı, sayfa başlığı ve arama terimi gibi değerler site ziyaretçilerinin kontrolündedir (referrer spam'i metin taşıyabilir). Mevcut taint kuralı (`docs/chat-engine.md`) o turda yazma araçlarını kapatır.
- **Gölge mod:** `GA_INSIGHTS=shadow` iken bulgular yalnız kaydedilir ve sahibin incelemesi için listelenir; kullanıcıya gösterilmez. 2 hafta sonra 30 bulguluk örnekte isabet ≥ %70 ise `on` yapılır.

### 3.7 Uyarılar, raporlama ve planlama (GA-F5)

**Uyarı yönlendirme** (ortak `MonitorAlert`; LLM puanlamasından geçmez):

| Önem     | Örnek                                                                                                   | Kanal                                                                                                                                                                                                           | Yeniden bildirim                             |
| -------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| CRITICAL | Veri akışı durdu (MH1), key event durdu (MH6), URL'de kişisel veri (MH12), GA erişimi koptu             | Uygulama içi kırmızı şerit + Works "Needs attention" + "Website analytics" sohbeti. Proje Telegram'ı bağlıysa **sayı içermeyen** bir mesaj: "Google Analytics stopped receiving data for Acme. Open Agentelse." | Önem artarsa ya da 24 saat sonra hâlâ açıksa |
| WARN     | Unassigned payı yüksek, self-referral, çift sayım şüphesi, mülk-alan adı uyuşmazlığı, senkron başarısız | Uygulama içi kart + günlük nabız                                                                                                                                                                                | Nabızda                                      |
| INFO     | Saklama 2 ay, gelişmiş ölçüm kapalı, eşikleme                                                           | "Website" sayfası + haftalık rapor                                                                                                                                                                              | —                                            |

- Telegram'a Google'dan okunan sayı, sayfa yolu ya da kampanya adı gitmez. Limited Use, veriyi yalnız kullanıcıya görünen özellik için işlemeye izin verir; Telegram yalnız "uygulamayı aç" çağrısı taşır.
- Uyarılar `(proje, kaynak, dedupeKey)` başına tek satırdır. Koşul tekrarlarsa `occurrences` artar; düzelince uyarı kendiliğinden RESOLVED olur. "Mute for 7 days" seçeneği vardır.

**Raporlar:**

| Rapor                  | Zaman                                           | İçerik                                                                                                                                                                                                                                                                            | Yüzey                                                                                                        | Maliyet                                     |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Website pulse          | Dünkü veri gelince (mülk saatiyle ~16:00-18:00) | Dün ile olağan gün (haftanın günü), açık uyarılar, en büyük 1-2 değişim, tazelik. Not edilecek bir şey yoksa çıkmaz                                                                                                                                                               | "Website analytics" sohbeti                                                                                  | Google 0 (ambar), LLM 0 (şablon)            |
| Haftalık rapor         | Pazartesi 08:00, proje saati                    | KPI tablosu (bu hafta, geçen hafta, Δ%, geçen yılın aynı haftası), kanallar, kazanan/kaybeden açılış sayfaları, key event'ler, AI asistanları, site araması, Agentelse katkısı (GA-F6), reklam kalitesi (GA-F6), ölçüm sağlığı, en önemli 3-5 bulgunun açıklaması, 3 sonraki adım | "Website analytics" sohbetinde rapor kartı; Markdown ve yazdırma (Analytics modülünün `export.ts`'i)         | Google 0, 1 LLM (number-check'li)           |
| Aylık / müşteri raporu | Ayın 2'si 08:00                                 | Ay ile önceki ay ve geçen yılın aynı ayı, hedefler, kanal karışımı, en iyi sayfalar, dönüşümler, ücretli trafik kalitesi, ölçüm sağlığı, uygulanan önerilerin sonuçları, gelecek ayın planı                                                                                       | Rapor kartı + Analytics modülünün paylaşım adımı (Copy / Markdown / Print); ajans için beyaz etiket GA-F8'de | 0-2 Google çağrısı (YoY doğrulaması), 1 LLM |
| İsteğe bağlı analiz    | Sohbette                                        | Ör. "Why did leads drop last week?" → AN2 ayrıştırması                                                                                                                                                                                                                            | Sohbet araçları                                                                                              | Google 0 (ambar; gerekirse P1), 1 LLM       |

- Raporlar ambarın görünümleridir; ayrı bir rapor tablosu tutulmaz.
- Haftalık ve aylık rapor kartları sohbette **saklanan kart** olarak yazılır (bugünkü desen: SYSTEM Command + `parsedIntent.card`). Böylece gönderilen raporun sayıları sonradan GA revizyonlarıyla değişmez. Works sohbet sorgusuna (`page.tsx:330-360`) yeni kart türü eklenir.

**"Website analytics" sohbeti:** Proje başına sistemin açtığı tek bir Work'tür (`wkga_<projectId>`, modül `analytics`). Haftalık taslağın desenini izler (`weekly-plan-draft.ts`) ve yalnız ilk kart yazılacağı zaman oluşturulur. Nabız, raporlar ve uyarılar buraya düşer; kullanıcı aynı sohbette soru sorar.

**Planlama:**

- **Hedefler:** `ProjectGoal.metricKey` için GA anahtarları: `ga.sessions`, `ga.keyEvents`, `ga.keyEvent:<olay_adı>`, `ga.revenue`, `ga.engagementRate`, `ga.keyEventRate`. `currentValue` her gün ambardan, ay başından bugüne değerle yazılır. `ProjectGoal` modelinde dönem alanı yoktur; takvim ayı varsayılır.
- **Tempo:** doğrusal plan + haftanın günü ağırlıklarıyla "On track / At risk / Behind". "At risk" durumu bir AN15 bulgusudur.
- **Tahmin:** ay sonu = bugüne kadarki değer + kalan günlerin beklenen değeri (son 8 haftanın haftanın günü tabanı × eğilim). 13 aydan uzun geçmiş varsa geçen yılın aynı dönem oranıyla mevsimsellik eklenir. Aralık, artıklardan hesaplanır. 8 haftadan kısa geçmişte tahmin gösterilmez.
- **Aylık plan kartı** ("Next month plan", ayın 2'si): her hedef için öneri (son 3 ay tabanı + mevsimsellik; ör. "realistic: +10-15%"), en yüksek etkili 3 bulgu, içerik ve reklam için girdi (yüksek dönüşümlü konular, kanal kalitesi). Kullanıcı hedefleri onaylarsa `ProjectGoal` güncellenir.
- **İçerik ve reklam planlamasına girdi:** Fikir motoru bağlamına (`idea-context.ts`) GA özetinden kısa bir satır eklenir ("Best converting topics: …"). Meta Ads planının planlama motoru (F5) GA'dan açılış sayfası ve kanal kalitesini okur.

### 3.8 Kapalı döngü ve reklam ölçümü (GA-F6)

**UTM standardı** (`src/lib/utm.ts`; saf ve testli):

| Bağlam                      | `utm_source` | `utm_medium`  | `utm_campaign`            | `utm_content`            | Not                                                                                                                                                                                       |
| --------------------------- | ------------ | ------------- | ------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta reklamı                | `facebook`   | `paid_social` | `agx-<kampanya-kısa-adı>` | `agx_<TrackedLink kodu>` | Kreatifin `url_tags` alanıyla eklenir; yerleşim `utm_term={{site_source_name}}` makrosuyla taşınır (makro listesi doğrulanmalı). Meta Ads planındaki P11 "UTM şablonu" bu modülü kullanır |
| Facebook link postu         | `facebook`   | `social`      | `agx-<plan-kısa-adı>`     | `agx_<kod>`              | Bugün Facebook postları link taşımıyor (`meta-client.ts:950-986`); link eklenince geçerli olur                                                                                            |
| Instagram bio / story linki | `instagram`  | `social`      | `agx-bio` / `agx-<plan>`  | `agx_<kod>`              | Organik Instagram altyazısında tıklanabilir link yok. Agentelse etiketli bio linkini üretir, kullanıcı yapıştırır                                                                         |
| LinkedIn / X / TikTok       | Platform adı | `social`      | `agx-<plan>`              | `agx_<kod>`              | Bu kanallara link gittiğinde                                                                                                                                                              |
| SEO makalesi                | —            | —             | —                         | —                        | Sitenin kendi iç linkleri **asla** UTM almaz (oturumu böler)                                                                                                                              |

- Değerler GA4'ün varsayılan kanal kurallarına göre seçildi: sosyal kaynak + `social` → Organic Social; sosyal kaynak + `paid…` → Paid Social.
- Yalnız projenin kendi alan adlarına giden linkler etiketlenir. Var olan `utm_*` korunur (çift etiket yok); `http(s)` dışındaki linklere dokunulmaz.
- Kampanya adları küçük harf ve tirelidir; Türkçe karakterler ASCII'ye katlanır (`text-fold.ts`).
- **Ayar:** Settings → "Add tracking (UTM) to links", varsayılan açık (GK10).

**`TrackedLink`:** Her etiketli link için 6 karakterlik bir kod, varlık türü ve kimliği (post, creative, reklam, kampanya, bio), kanal ve hedef adres tutulur. `utm_content=agx_<kod>` GA4'te `sessionManualAdContent` olarak görünür; `campaign` raporundaki satırlar bu kodla Agentelse varlığına bağlanır.

**Agentelse atfı:** "Website" sayfasında ve haftalık raporda bir "From Agentelse" bölümü olur: post ya da reklam başına oturum, etkileşim oranı, key event ve gelir. Organik sosyaldeki linksiz trafik (profilden siteye gelenler) ayrıştırılamaz. Bu yüzden metin "tracked links" diye sınırlanır; "all social traffic" denmez.

**Reklam ölçümü (GA4 gözünden):**

- **Ücretli trafik kalitesi:** kampanya ve açılış sayfası başına oturum, etkileşim oranı, key event oranı, gelir, mobil/masaüstü (AN12).
- **Meta çapraz kontrolü** (Meta Ads planının ambarı varsa; AN13):
  - Meta link tıklamasından GA oturumuna kayıp %40'ı aşarsa açılış sayfası hızı ya da izleme sorunu olabilir.
  - Meta "Results" ile GA key event farkı %30'u aşarsa ölçüm denetimi önerilir.
  - Meta'nın 7 gün tıklama / 1 gün görüntüleme atfı GA4'ün atfından farklıdır; fark normaldir. Eşik bunu hesaba katar ve iki sayı yan yana, etiketli gösterilir.
- **GA tabanlı maliyet metrikleri:** Meta harcaması (Meta ambarından) / GA key event'i = "Cost per key event (GA4)". Meta'nın kendi CPA'sının yanında gösterilir; kaynak çizgisi açıktır (harcama Meta'dan, sonuç GA'dan).
- **Google Ads** (mülke bağlıysa, salt okunur; AN14): kampanya başına maliyet, tıklama, GA key event'i ve gelir; ROAS eğilimi. Google Ads yönetimi bu planın dışındadır (ayrı bir entegrasyon olur).
- **Karar kaydına kanıt:** `getGaOutcomesForCampaign(projectId, campaignTag, range)` okuma API'si, Meta Ads planının optimizasyon motoruna (F4) "ikinci görüş" kanıtı verir; tek başına karar vermez.
- **Kanal bütçesi önerisi** (aylık plan kartında, yönlü): kanal başına marjinal key event maliyeti ve kalite karşılaştırılır. "Shift 10-20% of budget from X to Y" önerisi yalnız iki kanalın farkı istatistik kapısını geçerse yapılır.

**Öğrenmeler:** `BrandLearning` kaydı açılır (`sourceType = "GA4"`; alan String olduğu için migration gerekmez), polarity WORKS ya da AVOID. Yalnız kapıyı geçen sonuçlar ya da en az 2 kez görülen desenler yazılır. Örnek: "Offer-led carousel ads brought 2.4× more engaged sessions per click than lifestyle posts (n=6 ads, directional)."

### 3.9 Arayüz yüzeyleri

| Yüzey                                                                                                                                                                          | Ne gösterir                                                                                                                                                                                                                                                                                                                                              | Eylemler                                                                                                                           | Faz           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Integrations → Google Analytics (`GoogleTile` / `GoogleDialog`)                                                                                                                | Durum rozeti (Connected / Needs reconnect / Needs permission / Property access lost), "Connected as", mülk kartı (ad, kimlik, saat dilimi, para birimi, akış adresi, ölçüm kimliği), alan adı uyarısı, "Data through Oct 5", ölçüm puanı, eski ortak token notu                                                                                          | Reconnect, Use existing connection, Change property, Refresh, Disconnect, Delete data now                                          | GA-F1 – GA-F3 |
| "Website" sayfası (`/projects/[projectId]/site`; rota adı mevcut düzene uyar: `takvim`, `fikirler`. Sol menüde Explore altından (`sidebar-nav.tsx`) ve Brand kartından açılır) | Karşılaştırmalı KPI başlığı, tek trend grafiği, kanallar, açılış sayfaları, key event'ler, AI asistanları, site araması, "From Agentelse", reklam kalitesi, "Measurement health" paneli, bulgular ("What changed", "Opportunities"), isteğe bağlı "Right now" (son 30 dakikada aktif kullanıcı; yalnız sayfa açıkken, dakikada en çok 1 realtime isteği) | Dönem ön ayarları (7/28/90 gün, bu ay, geçen ay) + tek tarih seçiciyle özel aralık; Accept / Dismiss; Refresh (5 dakikada bir, P1) | GA-F2 – GA-F6 |
| Brand sekmesi "Website" kartı (`brand-summary-panel.tsx`, `brand-overview-cards.tsx`)                                                                                          | Son 28 gün oturum ve key event, eğilim oku, sağlık noktası                                                                                                                                                                                                                                                                                               | "Open" → Website sayfası                                                                                                           | GA-F2         |
| Analytics modül kartı                                                                                                                                                          | GA bölümü genişler: kanallar, açılış sayfaları, key event'ler; anında derleme                                                                                                                                                                                                                                                                            | Mevcut adımlar                                                                                                                     | GA-F2 / GA-F5 |
| "Website analytics" sohbeti                                                                                                                                                    | Nabız, haftalık ve aylık rapor, uyarı kartları; sohbet araçları                                                                                                                                                                                                                                                                                          | Soru sorma, Accept / Dismiss                                                                                                       | GA-F4 / GA-F5 |
| Works "Needs attention"                                                                                                                                                        | GA kritik uyarıları                                                                                                                                                                                                                                                                                                                                      | Open / Mute                                                                                                                        | GA-F3         |
| Settings                                                                                                                                                                       | "Add tracking (UTM) to links", rapor günleri, uyarı tercihleri                                                                                                                                                                                                                                                                                           | Aç / kapat                                                                                                                         | GA-F5 / GA-F6 |
| Sıradaki adım şeridi (`journey.ts`)                                                                                                                                            | "Connect Google Analytics", "Fix tracking: no key events"                                                                                                                                                                                                                                                                                                | Tek dokunuş                                                                                                                        | GA-F3         |
| /health (operatör)                                                                                                                                                             | GA API hata oranı, kota kullanımı (yalnız sayaçlar), senkron gecikmesi, token sağlığı sayıları                                                                                                                                                                                                                                                           | "Retry sync"                                                                                                                       | GA-F2         |

- Grafikler yazılırken `dataviz` yönergesi uygulanır. Tek bir duyarlı düzen kullanılır (mobilde de); çoklu görünüm modu yoktur.
- /health hiçbir müşteri verisini göstermez. Limited Use gereği insanlar kullanıcı verisini okumaz; ekranda yalnız sayaçlar ve hata kodları vardır.

### 3.10 Sohbet ve modüllerle bağ

- Analytics modül sohbetinde (`MODULE_TOOLS.analytics`) ve "Website analytics" sohbetinde §3.6'daki dört araç açılır.
- `ANALYTICS_ANALYSIS` görevi özeti ambardan, sabit 28 gün yerine istenen dönem için döndürür; sohbetin görev açmasına gerek kalmaz.
- SEO Manager (Search Console planı) bir sayfayı iyileştirirken GA'dan o sayfanın etkileşim ve dönüşüm oranını okur (köprü, §12).

### 3.11 Güvenlik, gizlilik ve uyumluluk

- **Limited Use beyanı:** Gizlilik politikasına (isteğe bağlı olarak ana sayfaya da) Google'ın verdiği kalıp eklenir: "Agentelse's use of information received from Google APIs will adhere to Google API Services User Data Policy, including the Limited Use requirements." Beyan herkese açık bir sayfada olmalıdır.
- **Gizlilik politikasında Google bölümü** (`privacy/page.tsx`, Meta bölümünden sonra):
  - izin ve amacı (`analytics.readonly`: raporlar, denetim, öneriler),
  - saklananlar (şifreli refresh token, e-posta, mülk listesi ve seçimi, toplulaştırılmış günlük metrikler ve saklama süreleri, bulgular),
  - yapay zekâ işlemesi (toplulaştırılmış sayılar ve maskelenmiş sayfa yolları AI sağlayıcısına rapor ve açıklama için gider; orada saklanmaz ve eğitimde kullanılmaz),
  - verinin satılmadığı ve reklam için kullanılmadığı,
  - insanların veriyi okumadığı (kullanıcı onayı, güvenlik ve yasal zorunluluk dışında),
  - Disconnect ve silme yolu, Google hesabından iptal.
- **Yapay zekâ:** Google'ın genel kullanıcı verisi politikasında açık bir "AI eğitimi" maddesi yok (o madde Workspace API politikasında). Yine de en güvenli yorum uygulanır: veri yalnız kullanıcıya görünen özellik için çıkarım amacıyla işlenir, hiçbir modeli eğitmek için kullanılmaz ve bu gizlilik metninde açıkça yazılır (doğrulanmalı: hukuki görüş).
- **Veri azaltımı:** yalnız toplulaştırılmış veri; demografik ve kitle boyutu yok; IP ya da kullanıcı kimliği yok; sayfa yolları PII süzgecinden geçer; LLM'e en fazla ilk 20 sayfa yolu gider.
- **Kalıcı kopya:** Google API Hizmet Şartları, içerik sahibi izin vermedikçe "kalıcı kopya ve veritabanı" oluşturmayı yasaklar. Buradaki içerik sahibi kullanıcının kendisidir. Bu yüzden üç şey yapılır: bağlanma ekranında açık beyan ("Agentelse keeps daily summaries of your Google Analytics data to build reports. You can delete them anytime."), gizlilik metni ve "Delete data now" (doğrulanmalı: hukuki görüş).
- **Şifreleme:** refresh token AES-256-GCM ile şifrelenir (`crypto.ts`); anahtar sürümü (`keyId`) GA-F8'de gelir; access token yalnız bellekte tutulur.
- **Kiracı izolasyonu:** her sorgu `projectId` ile yapılır. Seçilen mülk kimliği sunucuda grant'in mülk listesine karşı doğrulanır. Grant paylaşımı yalnız aynı workspace içinde mümkündür.
- **Prompt injection:** GA'dan gelen her metin (referrer, sayfa başlığı, arama terimi, kampanya adı) güvenilmez veridir. `cleanWorksText` ile temizlenir ve kırpılır, LLM isteminde "data" bloğunda gider; araçlar `external: true` işaretlidir.
- **Denetim:** bağlanma, kopma, mülk değişikliği, grant paylaşımı, veri silme ve GA-F7 yazmaları `AuditLog`'a yazılır.
- **Cross-Account Protection (RISC):** Google önerir ama doğrulama şartı değildir. Token iptalini anında öğrenmek için GA-F8'de değerlendirilir.
- **OAuth state:** İmzalı state 10 dakika geçerlidir ama tek kullanımlık değildir (nonce yok; `oauth-state.ts`). Callback'teki oturum kullanıcısı kontrolü ve GA-F1'de eklenen PKCE, çalınan bir yetkilendirme kodunun başka bir oturumda kullanılmasını engeller.

---

## 4. Veri modeli

**Adlandırma ve alan türleri:**

- GA tabloları `Ga*` önekini taşır; Search Console planı `Gsc*` ve `Seo*` kullanır. Ortak tablolar: `GoogleGrant`, `MonitorAlert`, `SystemHeartbeat`.
- `MonitorAlert` bu planda kavramsal addır. Fiziksel tablo, Meta Ads uygulamasının kurduğu `AdsAlert`'tir (6 Ekim, commit'siz); GA-F3'te ona boş olabilen bir `source` kolonu eklenir (GK8). GA ve GSC uyarılarının `dedupeKey`'i kaynakla başlar (`ga4:…`, `gsc:…`); Meta'nın anahtarlarıyla çakışmaz.
- `kind`, `health`, `status` gibi alanlar String'dir (TS union); yeni bir değer migration gerektirmez (Meta planıyla aynı ilke).
- Para alanları mülkün para biriminde **mikro birimdir** (`BigInt`, değer × 1.000.000). GA gelirleri ondalıklı döner; float tutulmaz.

| Model (faz)                          | Amaç                                                                     | Ana alanlar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Benzersiz / indeks                                                                                  | Tahmini hacim                                                   | Saklama                                  |
| ------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------- |
| `GoogleGrant` (GA-F1, ortak)         | Google hesabı × servis × workspace erişimi; refresh token'ın tek kaynağı | `workspaceId, service ("analytics" / "search_console" / "legacy_combined"), googleSub, email, encryptedRefreshToken, scopes[], status (CredentialStatus), healthReason, createdByUserId, lastRefreshAt, lastHealthAt`                                                                                                                                                                                                                                                                                                                                                   | `@@unique([workspaceId, service, googleSub])`, `@@index([googleSub])`                               | Workspace başına 1-5                                            | Son bağlantı kopunca silinir             |
| `IntegrationCredential` (değişiklik) | Proje bağlantısı                                                         | + `grantId String?` (yeni satırlarda `encryptedSecret` boş)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Mevcut `@@unique([projectId, provider])`                                                            | —                                                               | —                                        |
| `GaPropertyLink` (GA-F2)             | Proje ↔ GA4 mülkü; metadata, sağlık, kota ve senkron durumu              | `workspaceId, projectId, credentialId, grantId, propertyId, propertyName, accountId, accountName, timeZone, currencyCode, industryCategory, serviceLevel, propertyCreatedAt, streamId, measurementId, streamUri, keyEvents (Json), dataRetention, linkedProducts (Json: googleAds, bigQuery, searchConsole), catalog (Json: düşen raporlar), health, healthReason, healthScore, lastQuota (Json), rateLimitedUntil, serverErrorsHour (Json), syncLeaseUntil, syncLeaseOwner, consecutiveFailures, lastMetadataAt, lastDailyAt, lastFinalDate, backfill (Json), primary` | `@@unique([projectId, propertyId])`, `@@index([health, syncLeaseUntil])`                            | Proje başına 1 (GA-F8'de birkaç)                                | Bağlantı yaşadıkça; Disconnect + 30 gün  |
| `GaDailyTotal` (GA-F2)               | Mülk-gün toplamı (KPI kaynağı)                                           | `linkId, projectId, date (@db.Date, mülk günü), activeUsers, newUsers, sessions, engagedSessions, userEngagementSec, screenPageViews, eventCount, keyEvents (Float), revenueMicros (BigInt), transactions, quality (Json), preliminary, isFinal, fetchedAt`                                                                                                                                                                                                                                                                                                             | `@@unique([linkId, date])`, `@@index([projectId, date])`                                            | Mülk başına yılda 365                                           | 400 gün                                  |
| `GaReportSlice` (GA-F2)              | Katalog raporunun bir dönemi (kompakt satırlar)                          | `linkId, projectId, reportKey, grain (DAY / WEEK), periodStart (@db.Date), specVersion, dimensionHeaders[], metricHeaders[], rows (Json: dizi dizisi), rowCount, truncated, otherRow (Json?), quality (Json), preliminary, isFinal, fetchedAt`                                                                                                                                                                                                                                                                                                                          | `@@unique([linkId, reportKey, grain, periodStart])`, `@@index([projectId, reportKey, periodStart])` | Mülk başına günde ~12, yılda ~5 bin satır; satır başına 2-60 KB | GK4: günlük 95/400 gün, haftalık 400 gün |
| `GaMonthlySummary` (GA-F2)           | Uzun dönem eğilimi ve YoY için aylık özet                                | `linkId, projectId, month (@db.Date), totals (Json), channels (Json), topPages (Json, ilk 50)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `@@unique([linkId, month])`                                                                         | Mülk başına yılda 12                                            | 36 ay                                    |
| `GaHealthCheck` (GA-F3)              | Ölçüm kontrolünün güncel durumu                                          | `linkId, projectId, checkKey, status, severity, evidence (Json), guideId, firstFailedAt, lastCheckedAt, lastChangedAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `@@unique([linkId, checkKey])`                                                                      | Mülk başına ~25                                                 | Bağlantı yaşadıkça                       |
| `MonitorAlert` (GA-F3, ortak)        | Tekilleştirilmiş uyarı (GA, GSC, SEO, Meta)                              | `workspaceId, projectId, source ("GA4" / "GSC" / "SEO" / "META_ADS" / "SYSTEM"), subjectRef, kind, severity, status, dedupeKey, title, detail, data (Json), firstSeenAt, lastSeenAt, occurrences, notifiedAt, notifyChannels[], mutedUntil, resolvedAt`                                                                                                                                                                                                                                                                                                                 | `@@unique([projectId, source, dedupeKey])`, `@@index([projectId, status, severity])`                | Proje başına onlarca                                            | Çözülenler 180 gün                       |
| `GaFinding` (GA-F4)                  | Analiz bulgusu ve sonucu                                                 | Taslak aşağıda                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `@@unique([fingerprint])`, `@@index([projectId, status])`                                           | Proje başına ayda 5-30                                          | 24 ay                                    |
| `TrackedLink` (GA-F6)                | Etiketli link ↔ Agentelse varlığı                                        | `id (6 karakterlik kod), workspaceId, projectId, entityType, entityId, channel, destinationUrl, taggedUrl, utmSource, utmMedium, utmCampaign, createdAt`                                                                                                                                                                                                                                                                                                                                                                                                                | `@@index([projectId, utmCampaign])`, `@@index([entityType, entityId])`                              | Proje başına ayda 10-100                                        | Varlık yaşadıkça                         |
| `GaConfigChange` (GA-F7)             | GA yapılandırma yazmasının kaydı                                         | `linkId, projectId, kind, before (Json), after (Json), approvalId, taskId, actorUserId, status, appliedAt, verifiedAt, rolledBackAt, error (Json)`                                                                                                                                                                                                                                                                                                                                                                                                                      | `@@index([projectId, createdAt])`                                                                   | Seyrek                                                          | 24 ay                                    |
| `SystemHeartbeat` (Meta F0b, ortak)  | Nabız                                                                    | Anahtarlar: `ga.sync`, `ga.calls`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | PK                                                                                                  | —                                                               | —                                        |

Kısa şema taslağı:

```prisma
model GoogleGrant {
  id                    String           @id @default(cuid())
  workspaceId           String
  service               String           // "analytics" | "search_console" | "legacy_combined"
  googleSub             String           // userinfo "id"
  email                 String
  encryptedRefreshToken String
  scopes                String[]
  status                CredentialStatus @default(ACTIVE)
  healthReason          String?
  createdByUserId       String
  lastRefreshAt         DateTime?
  lastHealthAt          DateTime?
  createdAt             DateTime         @default(now())
  updatedAt             DateTime         @updatedAt
  @@unique([workspaceId, service, googleSub])
  @@index([googleSub])
}

model GaFinding {
  id            String    @id @default(cuid())
  workspaceId   String
  projectId     String
  linkId        String
  ruleKey       String    // "AN2_CHANGE_DECOMPOSITION"
  ruleVersion   Int
  kind          String    // ANOMALY | CHANGE | OPPORTUNITY | RISK | WIN
  subject       String    // "channel:Organic Search", "page:/pricing"
  periodStart   DateTime  @db.Date
  periodEnd     DateTime  @db.Date
  severity      String    // INFO | WARN | CRITICAL
  confidence    String    // SIGNIFICANT | DIRECTIONAL
  status        String    // OPEN | ACCEPTED | DISMISSED | DONE | EVALUATED | EXPIRED | SUPERSEDED | RESOLVED
  evidence      Json      // pencereler, metrikler, geçen kapılar
  impact        Json?     // { metric, perWeek, low, high }
  explanation   String?   // LLM; number-check'ten geçmiş
  fingerprint   String    @unique // kural + konu + dönem
  signalId      String?
  ideaIds       String[]
  evaluateAfter DateTime?
  evaluatedAt   DateTime?
  outcome       String?   // WORKED | DIDNT | INCONCLUSIVE
  createdAt     DateTime  @default(now())
  @@index([projectId, status])
}
```

**Mevcut modellerle ilişki:**

- `GaPropertyLink.credentialId` → `IntegrationCredential` (provider `google_analytics`); `grantId` → `GoogleGrant`.
- `GaFinding.signalId` → `Signal`; `ideaIds` → fikir havuzu. `ProjectGoal.currentValue` ambardan beslenir.
- `IntegrationCredential.metadata` içindeki GA alanları (`ga4Properties`, `selectedGa4PropertyId`, `previousAnalyticsSnapshot`, `lastAnalyticsScanAt`…) geçiş boyunca okunur. GA-F2'den sonra yalnız seçim alanları yazılır; `previousAnalyticsSnapshot` ve tarama defteri yazılmaz. Bu alanların silinmesi ayrı bir iştir ve sahibin onayını gerektirir.
- FK'ler proje silinince cascade eder; `project-deletion.service.ts` ile uyumludur.

**Migration stratejisi** (Meta planı §4 ve sahibin kurallarıyla aynı):

1. Her fazın kendi yeni migration klasörü olur; var olan migration dosyası asla düzenlenmez.
2. Yalnız ekleme yapılır: `CREATE TABLE`, nullable ya da varsayılanlı `ADD COLUMN`. Aynı fazda yeniden adlandırma ya da silme yapılmaz.
3. SQL, tek kullanımlık yerel Postgres'e karşı `prisma migrate diff` ile üretilir. Paylaşılan DB'de `migrate dev` ve `db push` asla çalıştırılmaz.
4. Railway başlangıcında `prisma migrate deploy` çalışır. Yarım migration klasörü çalışma ağacında bırakılmaz, çünkü sahibin terminalindeki `migrate deploy` commit'siz klasörleri de canlıya uygular.
5. Backfill tembel ve idempotenttir: `GaPropertyLink` ilk senkronda `IntegrationCredential.metadata`'dan oluşturulur; eski ortak token'lar ilk kullanımda `legacy_combined` grant'e taşınır.
6. Saklama temizliği (`ga-retention`) yalnız süresi dolmuş satırları siler.

---

## 5. İşler, zamanlama ve kota bütçesi

| İş                            | Sıklık                                                                                                     | Tetikleyici      | Kilit                               | Google bütçesi                                                | Başarısızlıkta                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `google-grant-health` (ortak) | Günlük + bağlanırken                                                                                       | Ajans tick adımı | `GoogleGrant.lastHealthAt` CAS      | Grant başına 1 refresh + 1 `tokeninfo` + 1 `accountSummaries` | AUTH → EXPIRED + uyarı                                                                                       |
| `ga-sync`                     | Her tick'te vadesi gelen en çok 3 bağlantı                                                                 | Ajans tick adımı | `GaPropertyLink` kilidi (5 dk, CAS) | §5.1; P2                                                      | Üstel geri çekilme (5 dk → 6 sa). RATE_LIMIT → `rateLimitedUntil`. AUTH → dur. 3 ardışık hata → SYNC_FAILING |
| ├ metadata                    | 24 sa (Admin API: mülk, akışlar, key event'ler, saklama, Google Ads bağlantıları) + haftalık `getMetadata` |                  |                                     | 5-6 Admin çağrısı                                             |                                                                                                              |
| ├ daily                       | Mülk saatiyle 16:00'dan sonra bir kez (veri yoksa 18:00 ve 21:00'de yeniden)                               |                  |                                     | ~12 rapor isteği (3 batch)                                    | Sonraki deneme                                                                                               |
| ├ revisions                   | Günlük çekimin içinde (D-1…D-7; atıf D-1…D-13)                                                             |                  |                                     | Ek istek yok (aynı istek aralığı)                             |                                                                                                              |
| ├ weekly                      | Pazartesi (haftalık dilimler, `site_search`, `search_console`)                                             |                  |                                     | ~6 istek                                                      |                                                                                                              |
| ├ backfill                    | Bağlanınca, parça parça                                                                                    |                  |                                     | 60-90 istek, 5-15 bin token; iki güne yayılabilir             | Kaldığı yerden sürer                                                                                         |
| └ intraday / realtime         | Yalnız sayfa açıkken (2 sa'te bir) / yalnız MH1 şüphesinde (saatte 1)                                      |                  |                                     | 1 istek                                                       |                                                                                                              |
| `ga-health`                   | Günlük çekimden sonra; site etiketi haftalık                                                               | Ajans tick adımı | Bağlantı + gün parmak izi           | 0 (ambar) + site için 6 HTTP isteği                           | Uyarı tekilleşir                                                                                             |
| `ga-analyze`                  | Günlük (AN1, AN15) + haftalık (Pazartesi 06:30, proje saati)                                               | Ajans tick adımı | Proje + dönem parmak izi            | 0                                                             | Sonraki tick                                                                                                 |
| `ga-pulse`                    | Dünkü veri gelince (mülk saati)                                                                            | Ajans tick adımı | Proje + gün                         | 0                                                             | Atlanır                                                                                                      |
| `ga-weekly-report`            | Pazartesi 08:00 (proje saati)                                                                              | Ajans tick adımı | Proje + hafta                       | 0 (+1 LLM)                                                    | Sonraki tick                                                                                                 |
| `ga-monthly-report`           | Ayın 2'si 08:00                                                                                            | Ajans tick adımı | Proje + ay                          | 0-2 (+1 LLM)                                                  | Sonraki tick                                                                                                 |
| `ga-goals`                    | Günlük, senkrondan sonra                                                                                   | Ajans tick adımı | Proje + gün                         | 0                                                             | —                                                                                                            |
| `ga-finding-evaluate`         | Günlük                                                                                                     | Ajans tick adımı | Bulgu CAS                           | 0                                                             | —                                                                                                            |
| `ga-retention`                | Günlük 03:00 UTC                                                                                           | Ajans tick adımı | Global kilit                        | 0                                                             | —                                                                                                            |

- Yeni adımlar `agency-wiring.ts` içinde `registerAgencyTickStep` ile kaydedilir.
- Adlar `legacy-loop.ts`'teki GENERATORS/DRAINERS listelerinin ve `FOCUS_DISABLED_TICK_STEPS`'in dışında kalır; böylece her modda çalışırlar.
- Bayraklar `process.env`'den çağrı anında okunur.
- Her senkron adımının sonunda `SystemHeartbeat("ga.sync")` yazılır (en fazla dakikada bir).

### 5.1 Kota bütçesi

**Google sınırları** (Data API; Core, Realtime ve Funnel kategorileri ayrı sayılır ama boyları aynıdır):

| Sınır                                             | Standart | 360       |
| ------------------------------------------------- | -------- | --------- |
| Mülk başına günlük token                          | 200.000  | 2.000.000 |
| Mülk başına saatlik token                         | 40.000   | 400.000   |
| Proje başına, mülk başına saatlik token           | 14.000   | 140.000   |
| Mülk başına eşzamanlı istek                       | 10       | 50        |
| Proje↔mülk başına saatlik sunucu hatası (500/503) | 10       | 50        |

- Ek sınırlar: mülk başına saatte 120 "eşiklenebilir" istek (demografik ve kitle boyutları; katalogda yok) ve proje↔mülk başına 15 dakikada 10.000 istemci hatası.
- Günlük kotalar gece yarısı PST'de sıfırlanır; çoğu istek 10 ya da daha az token tüketir.
- Admin API kotaları ayrıdır (doğrulanmalı). Kullanımımız mülk başına günde 10 çağrının altındadır.

**Bir mülkün günlük kullanımı (bizim tasarım):**

| Kalem                                          | Sıklık     | İstek      | Token/gün (tahmin)                    |
| ---------------------------------------------- | ---------- | ---------- | ------------------------------------- |
| Günlük çekim + 7/13 günlük revizyon (12 rapor) | Günlük     | 12         | 150-400                               |
| Haftalık dilimler                              | Haftada 1  | ~6         | ~20 (gün başına)                      |
| `getMetadata` / `checkCompatibility`           | Haftalık   | 2-3        | ~2                                    |
| Realtime (yalnız şüphede)                      | ≤ 14       | ≤ 14       | Ayrı kota                             |
| Sohbet ve "Refresh" (P1)                       | Olay bazlı | ≤ 20       | ≤ 200                                 |
| **Toplam**                                     |            | **~35-50** | **~400-650 (günlük kotanın ~%0,3'ü)** |

- Geri doldurma günü: ek 5-15 bin token (günlük kotanın en çok %8'i).
- Ajans senaryosu (100 mülk): projemizden günde ~4.000-5.000 istek gider. Kotalar mülk başına olduğundan toplam bir sorun yaratmaz. Proje↔mülk başına saatlik 14.000 token sınırı yalnız geri doldurmada dikkat ister; kota yöneticisi saatlik payın %50'sini aşınca işi böler.
- Token uç noktası: önbellek sayesinde grant başına saatte en çok 1 refresh yapılır (bugün her çağrıda 1).

---

## 6. Profesyonel oyun kitabı

KOBİ ölçeğine göre ayarlanmıştır: günde 20-2.000 oturum, çoğunlukla lead ya da mesaj odaklı, bir kısmı e-ticaret. Varsayımlar:

- Taban, mülkün kendi son 8 haftasıdır; sektör benchmark'ı kullanılmaz.
- Hacim düşükse günlük yerine haftalık bakılır.

### 6.1 Ölçüm sağlığı kontrolleri (GA-F3)

| Kod  | Kontrol                               | Kaynak            | Eşik                                                                                                                                                                                                    | Önem            | Düzeltme rehberi (özet)                                                                                                                                                |
| ---- | ------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MH1  | Veri akışı                            | DATA (+ realtime) | Dünkü oturum, haftanın aynı günü medyanının %10'undan az (medyan ≥ 20) → CRITICAL; %10-50 arası → WARN. Gün içinde: tabanın > 5 aktif kullanıcı beklediği saatte 3 ardışık realtime ölçümü 0 → CRITICAL | CRITICAL / WARN | Etiket kaldırıldı mı, çerez onayı mı engelliyor, site değişti mi; Tag Assistant ile kontrol                                                                            |
| MH2  | Veri gecikmesi                        | INTEGRATION       | Dünkü gün mülk saatiyle 21:00'e kadar gelmedi                                                                                                                                                           | INFO            | Google işleme gecikmesi; işlem gerekmez                                                                                                                                |
| MH3  | Etiket sitede                         | SITE              | Ana sayfa + ilk 5 açılış sayfasında akışın `G-` kimliği yok (GTM de yok) → WARN; farklı bir `G-` kimliği → WARN                                                                                         | WARN            | Doğru ölçüm kimliğini etikete yaz                                                                                                                                      |
| MH4  | Çift sayım                            | SITE + DATA       | Aynı sayfada iki `G-` kimliği ya da oturum başına görüntüleme tabanın ≥ 2 katı + etkileşim oranı > %95                                                                                                  | WARN            | gtag ve GTM'nin aynı anda yüklenmesini kaldır                                                                                                                          |
| MH5  | Key event tanımı                      | ADMIN             | Satın alma dışında key event yok (lead sitesi)                                                                                                                                                          | WARN            | Sitede bulunan `tel:`, `wa.me`, `mailto:`, form ve ödeme adımlarına göre önerilen olaylar; "Mark as key event"                                                         |
| MH6  | Key event sağlığı                     | DATA              | ≥ 7 gün 0 key event, oturumlar normal ve önceden günde ≥ 1 → CRITICAL. Tabanın ≥ 3 katı ve oturum başına key event > 1 → WARN (çift tetikleme)                                                          | CRITICAL / WARN | Formun teşekkür sayfası ya da olayı değişti mi; olay iki kez mi tetikleniyor                                                                                           |
| MH7  | Unassigned payı                       | DATA              | `Unassigned` kanalı oturumların > %5'i                                                                                                                                                                  | WARN            | En çok katkı veren kaynak/ortam çiftleri ve düzeltilmiş UTM örnekleri                                                                                                  |
| MH8  | UTM yazım hijyeni                     | DATA              | Aynı kaynağın büyük/küçük harf varyantları (`Instagram` / `instagram`), standart dışı ortamlar (`Social`, `post`, `ig`)                                                                                 | INFO            | Tek yazım; Agentelse'in UTM standardı                                                                                                                                  |
| MH9  | Self-referral                         | DATA              | `sessionSource` sitenin kendi alan adı ya da alt alan adı; oturumların > %2'si                                                                                                                          | WARN            | Alan adları arası ölçüm ve alt alan adı ayarı                                                                                                                          |
| MH10 | Ödeme / kimlik geçidi referansı       | DATA              | `paypal`, `stripe`, `iyzico`, `payu`, `checkout.*`, `accounts.google.com`, `appleid` kaynaklı oturumlar > %0,5                                                                                          | WARN            | "Unwanted referrals" listesine ekle                                                                                                                                    |
| MH11 | `(not set)` açılış sayfası            | DATA              | Oturumların > %5'i                                                                                                                                                                                      | WARN            | page_view olmadan başlayan oturumlar: çerez onayı, sunucu tarafı olaylar                                                                                               |
| MH12 | URL'de kişisel veri                   | DATA              | Sayfa yolunda ya da sorgu dizesinde e-posta deseni ya da `email=`, `phone=`, `tel=`, `name=`, `token=`                                                                                                  | CRITICAL        | Google şartlarına aykırı. Akış ayarında veri gizlemeyi (data redaction) aç ve formu POST'a çevir. Agentelse değeri saklamaz; yalnız parametre adını ve sayıyı gösterir |
| MH13 | Saat dilimi / para birimi             | ADMIN             | Mülk saat dilimi proje saat diliminden, para birimi markanınkinden farklı                                                                                                                               | INFO            | Mülk ayarı (geçmiş değişmez; ileriye dönük düzelir)                                                                                                                    |
| MH14 | Veri saklama                          | ADMIN             | Olay verisi saklama süresi 2 ay                                                                                                                                                                         | INFO            | 14 aya çıkar. Standart raporları değil, keşif ve huni raporlarını etkiler                                                                                              |
| MH15 | Google Ads bağlantısı                 | ADMIN + DATA      | `gclid`'li açılış sayfaları var ama `googleAdsLinks` boş                                                                                                                                                | INFO            | Google Ads'i GA4'e bağla                                                                                                                                               |
| MH16 | Search Console bağlantısı (GA içinde) | DATA              | `organicGoogleSearch*` metrikleri uyumsuz ya da boş                                                                                                                                                     | INFO            | İsteğe bağlı; Agentelse'in kendi Search Console entegrasyonu ayrıca bağlanabilir                                                                                       |
| MH17 | Gelişmiş ölçüm                        | ADMIN (v1alpha)   | Akışta gelişmiş ölçüm ya da site araması kapalı                                                                                                                                                         | INFO            | Aç (site araması terimleri AN8'i besler)                                                                                                                               |
| MH18 | Eşikleme sıklığı                      | DATA              | Katalog raporlarında `subjectToThresholding` sık görülüyor                                                                                                                                              | INFO            | Katalogda demografik boyut olmadığı için nadir olmalı; hangi raporda görüldüğü gösterilir. Ayar önerisi doğrulanmalı                                                   |
| MH19 | `(other)` kaybı                       | DATA              | Katalog raporlarında `dataLossFromOtherRow`                                                                                                                                                             | INFO            | Kimlik taşıyan UTM ve URL parametrelerini sadeleştir                                                                                                                   |
| MH20 | Spam / bot dalgası                    | DATA              | Tek ülke, şehir ya da kaynaktan tabanın ≥ 3 katı oturum ve etkileşim oranı < %5                                                                                                                         | WARN            | O günler tabandan çıkar; kaynak süzgeci önerisi                                                                                                                        |
| MH21 | Mülk ↔ alan adı eşleşmesi             | ADMIN             | Akış adresinin alan adı `Project.domain` değil ve alt alan adı ilişkisi de yok                                                                                                                          | WARN            | Doğru mülkü seç                                                                                                                                                        |
| MH22 | Etkileşim süresi tutarlılığı          | DATA              | Oturum var ama ortalama etkileşim süresi ≈ 0                                                                                                                                                            | WARN            | `user_engagement` olayı gelmiyor; etiket yapılandırması                                                                                                                |
| MH23 | Çerez onayı (AB trafiği)              | SITE (sezgisel)   | AB trafiği > %20 ve sayfada onay varsayılanı bulunamadı                                                                                                                                                 | INFO            | Consent Mode. Hukuki bir not; kesin hüküm değil                                                                                                                        |
| MH24 | Entegrasyon sağlığı                   | INTEGRATION       | Token, izin, mülk erişimi, kota; senkron gecikmesi > 36 sa                                                                                                                                              | Duruma göre     | Reconnect / izin / mülk seçimi                                                                                                                                         |
| MH25 | Agentelse UTM kapsamı (GA-F6)         | DATA              | Agentelse linklerinin < %90'ı etiketli ya da lansmandan 48 sa sonra `agx-` kampanyası GA'da görünmüyor                                                                                                  | INFO            | UTM ayarını aç; açılış sayfasındaki yönlendirme parametreleri siliyor mu                                                                                               |

### 6.2 Analiz kuralları (GA-F4)

| Kod  | Kural                       | Koşul / yöntem                                                                                                                                                                                                                  | Asgari veri                                                           | Çıktı                                                                                                  | Gerekçe                                                                                   |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| AN1  | KPI anomalisi               | Oturum, etkileşimli oturum, key event, gelir, key event oranı. Haftanın aynı gününün son 8 haftalık medyanı ve MAD'i ile sağlam z: \|z\| ≥ 3 anlamlı, 2-3 arası WARN                                                            | Taban medyanı günde ≥ 20 oturum ya da ≥ 3 key event; değilse haftalık | ANOMALY bulgusu + otomatik AN2 kırılımı                                                                | KOBİ trafiğinde haftanın günü etkisi baskın; ortalama/standart sapma uç değerlere duyarlı |
| AN2  | Değişim ayrıştırma          | WoW, MoM, YoY: ΔKE = Σ_k (ΔS_k × r_k,önce) [hacim] + Σ_k (S_k,sonra × Δr_k) [oran]. Önce kanal düzeyinde, sonra en büyük katkı veren kanalın açılış sayfalarında                                                                | Dönemde ≥ 30 key event (yoksa oturum üzerinden)                       | "Leads −32%: Organic Search sessions −40% (70% of the drop); Paid Social conversion 3.1% → 1.9% (25%)" | Tek sayı yerine neden; düzeltilecek yeri gösterir                                         |
| AN3  | Açılış sayfası fırsatı      | 28 günde oturumu ≥ max(100, sayfaların p75'i) ve key event oranı site oranının 0,5 katından düşük (iki oran testi) → CRO. Oranı site oranının ≥ 1,5 katı ve trafiği düşük → "promote"                                           | Grup başına ≥ 200 oturum ve ≥ 10 key event                            | OPPORTUNITY + etki tahmini                                                                             | Daha çok sonuca en kısa yol                                                               |
| AN4  | Kanal kalitesi              | Kanal başına etkileşim oranı ve key event oranı, site ortalamasıyla karşılaştırılır                                                                                                                                             | Kanal başına ≥ 200 oturum                                             | "Paid Social sessions engage 40% less than average"                                                    | Bütçe ve içerik kararlarına girdi                                                         |
| AN5  | Mobil/masaüstü farkı        | Mobil key event oranı masaüstünün 0,6 katından düşük                                                                                                                                                                            | Grup başına ≥ 200 oturum                                              | Mobil deneyim bulgusu                                                                                  | KOBİ trafiğinin çoğu mobil                                                                |
| AN6  | Yeni / geri dönen           | Geri dönen kullanıcı payı 8 haftada ≥ 5 puan düştü                                                                                                                                                                              | ≥ 500 kullanıcı/hafta                                                 | Sadakat bulgusu                                                                                        | İçerik ve CRM için sinyal                                                                 |
| AN7  | AI asistan trafiği          | `sessionSource` AI listesindeyse (`chatgpt.com`, `chat.openai.com`, `perplexity.ai`, `gemini.google.com`, `copilot.microsoft.com`, `claude.ai`…; liste `src/lib/website-analytics/ai-sources.ts`'te) eğilim ve açılış sayfaları | ≥ 10 oturum/ay                                                        | Eğilim + Search Console planına GEO sinyali                                                            | AI aramasındaki görünürlüğün tek doğrudan ölçüsü                                          |
| AN8  | Site içi arama              | 28 günün en sık `searchTerm`'leri; Search Console planındaki tarayıcı verisi varsa sitede karşılığı olmayanlar ayrıca işaretlenir                                                                                               | Terim başına ≥ 5 arama                                                | İçerik fikri (kanıtla)                                                                                 | Ziyaretçinin kendi kelimeleriyle içerik açığı                                             |
| AN9  | 404 trafiği                 | `pageTitle` "404 / not found / bulunamadı" ya da hata yolu kalıbı; oturum ≥ 10/hafta                                                                                                                                            | —                                                                     | Kırık link bulgusu (SEO planına da gider)                                                              | Kaybedilen ziyaret                                                                        |
| AN10 | İçerik etkileşimi           | Blog ve içerik sayfalarında etkileşimli oturum ve ortalama etkileşim süresi sıralaması; en iyi konular                                                                                                                          | Sayfa başına ≥ 50 oturum                                              | Öğrenme + fikir girdisi                                                                                | Hangi konuların işe yaradığı                                                              |
| AN11 | E-ticaret hunisi (varsa)    | `view_item → add_to_cart → begin_checkout → purchase` olay sayılarıyla adım oranları; tabana göre z. Ayrıca sepet ortalaması değişimi                                                                                           | Adım başına ≥ 50 olay/hafta                                           | Huni anomalisi                                                                                         | Gelir kaybının yeri                                                                       |
| AN12 | Kampanya sonuçları          | UTM kampanyası başına oturum, etkileşim, key event, gelir; `agx-` kampanyaları ayrıca gösterilir                                                                                                                                | ≥ 50 oturum                                                           | Kampanya tablosu ve bulgular                                                                           | Reklamın sitedeki gerçek etkisi                                                           |
| AN13 | Meta çapraz kontrolü        | Meta link tıklaması ile GA oturumu (kayıp > %40); Meta sonucu ile GA key event'i (fark > %30)                                                                                                                                   | ≥ 100 tıklama                                                         | Ölçüm denetimi önerisi                                                                                 | İki kaynağın birbirini doğrulaması                                                        |
| AN14 | Google Ads (GA4'e bağlıysa) | Kampanya başına maliyet, tıklama, GA key event'i ve gelir; ROAS eğilimi                                                                                                                                                         | ≥ 100 tıklama                                                         | Okuma bulguları                                                                                        | Ücretli aramanın sitedeki karşılığı                                                       |
| AN15 | Hedef temposu               | Dönem sonu tahmini planın %90'ının altında                                                                                                                                                                                      | Dönemin ≥ 5. günü                                                     | "At risk" bulgusu + öneri                                                                              | Planla bağ                                                                                |
| AN16 | Tatil ve sezon farkındalığı | Ülke bazlı resmî tatil takvimi (statik JSON; ilk sürüm TR, MK, RS, AL, BA, XK, BG, GR, DE, GB, US) ve 13+ ay geçmiş varsa YoY oranı                                                                                             | —                                                                     | Tatil günleri anomali tabanından çıkar; bulgu metnine not düşülür                                      | Bayramdaki düşüş bir "sorun" değildir                                                     |

### 6.3 İstatistik kapıları

- **Anomali:** sağlam z (medyan/MAD × 1,4826). \|z\| ≥ 3 → SIGNIFICANT; 2-3 arası → DIRECTIONAL. Taban, haftanın aynı gününün son 8 değeridir (şüpheli ve tatil günleri hariç). 4'ten az temiz değer varsa haftalık bakılır.
- **Oran karşılaştırmaları:** iki oran z-testi, p < 0,05; grup başına ≥ 200 oturum ve ≥ 10 olay. Sayfa düzeyindeki çoklu karşılaştırmalarda Benjamini-Hochberg (FDR %10) uygulanır. Kapıyı geçmeyen sonuç "directional" olur.
- **Sayım değişimleri:** Poisson yaklaşımıyla; key event sayısında %95 aralığının dışında kalan değişim anlamlıdır.
- **Kabul edilen önerilerin değerlendirmesi:** öncesi/sonrası 28 gün karşılaştırılır, değişiklikten sonraki ilk 7 gün hariç tutulur. Mümkünse kontrol grubu (benzer sayfalar) kullanılır. Sonuç WORKED / DIDNT / INCONCLUSIVE olur; INCONCLUSIVE öğrenme yazmaz.

### 6.4 Key event önerileri (işletme tipine göre)

| İşletme tipi  | Önerilen key event'ler                                                                 | Sitede aranan                                             |
| ------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Lead / hizmet | `generate_lead` ya da form gönderimi, `click_to_call`, `whatsapp_click`, `email_click` | `<form>`, `tel:`, `wa.me` / `api.whatsapp.com`, `mailto:` |
| E-ticaret     | `purchase` (varsayılan), `begin_checkout`, `add_to_cart`                               | Sepet ve ödeme yolları, ürün şeması                       |
| Yerel işletme | `click_to_call`, `get_directions` (harita linki), `book_appointment`                   | `maps.google.com` / `goo.gl/maps`, rezervasyon araçları   |
| İçerik / blog | `newsletter_signup`, belirli kaydırma derinliği                                        | Bülten formu                                              |

Agentelse bu olayları sitede tanımlamaz; etiket kurulumu kullanıcının ya da ajansın işidir. Agentelse rehber sunar, GA-F7'de de "Mark as key event" düğmesi.

---

## 7. Erişim ve Google doğrulaması önkoşulları

| Önkoşul                                 | Bugün                                                                                                               | Gereken                                                                                                                                                                                                                                                                                                                                                                                  | Ne zaman              | Beklenen süre                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| Google Cloud projesi ve OAuth istemcisi | Var (`GOOGLE_OAUTH_CLIENT_ID/SECRET`, `env.ts:160-165`)                                                             | Analytics Data API ve Admin API etkin olmalı (kontrol)                                                                                                                                                                                                                                                                                                                                   | GA-F0                 | —                                                                               |
| Yayın durumu                            | Bilinmiyor                                                                                                          | "In production" olmalı. "Testing" durumunda refresh token'lar **7 günde** düşer ve "Needs reconnection" haftalık görünür                                                                                                                                                                                                                                                                 | GA-F0                 | Anında                                                                          |
| İzinlerin sınıfı                        | Bilinmiyor                                                                                                          | Cloud Console → Data Access'te `analytics.readonly` sınıfı okunur. Resmî dokümanda izin başına bir liste yok; muhtemelen hassas                                                                                                                                                                                                                                                          | GA-F0                 | —                                                                               |
| OAuth doğrulaması                       | Marka doğrulaması için ana sayfa herkese açık (`public-paths.ts:3-6`); hassas izin doğrulamasının durumu bilinmiyor | Search Console'da doğrulanmış alan adı (proje Owner/Editor'ı tarafından); alan adında uygulamayı anlatan ve gizlilik politikasına link veren herkese açık ana sayfa; aynı alan adında gizlilik politikası; izin başına gerekçe (neden daha dar bir izin yetmez); YouTube'da liste dışı demo videosu (İngilizce onay akışı, uygulama adı, adres çubuğunda client ID, her iznin kullanımı) | GA-F1 canlıya çıkınca | Marka 2-3 iş günü; hassas izin ~10 iş günü (geliştirici dokümanı 3-5 gün diyor) |
| Doğrulanmamış uygulama sınırı           | —                                                                                                                   | Uyarı ekranı + Cloud projesinin **ömrü boyunca** en fazla 100 yeni kullanıcı (sıfırlanamaz)                                                                                                                                                                                                                                                                                              | Doğrulamaya kadar     | —                                                                               |
| Gizlilik politikası + Limited Use       | Yok                                                                                                                 | §3.11                                                                                                                                                                                                                                                                                                                                                                                    | GA-F1                 | —                                                                               |
| Yönlendirme adresi                      | `${NEXT_PUBLIC_APP_URL}/api/integrations/google/callback`                                                           | Canlı ve yerel adresler kayıtlı olmalı                                                                                                                                                                                                                                                                                                                                                   | GA-F0                 | —                                                                               |
| Test mülkü                              | —                                                                                                                   | Sahibin gerçek bir GA4 mülkü (tercihen trafiği olan bir müşteri ya da ajans sitesi). agentelse.com'da GA4 etiketi yok (GK16)                                                                                                                                                                                                                                                             | GA-F0 – GA-F2         | —                                                                               |

**Demo videosu senaryosu (GA):** giriş → proje → Connectors → Google Analytics → Google onay ekranı (izin görünür) → mülk seçimi → Website sayfası (KPI'lar, kanallar, ölçüm sağlığı) → haftalık rapor kartı → Disconnect ve "Delete data now". Anlatım: "Read-only access, used only to show reports and recommendations to you."

---

## 8. Test ve doğrulama stratejisi

Sahibin tercihi: ağır inceleme turları ve mutasyon testleri yapılmaz. Asgari kapı `tsc` + `eslint` + yeni ve etkilenen testlerdir. Bu makinede `npm run build` Turbopack hatası verdiği için `tsc` ve dev logu kullanılır; build CI'da çalışır.

| Katman            | Kapsam                                                                                                                                                                                                                                                                                                                                                                                                        | Yöntem                                                                                                          | Ortam      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- |
| Sözleşme          | Token yanıtı (`scope` var / eksik), `invalid_grant` (+ `invalid_rapt`), `tokeninfo`; `accountSummaries` sayfalaması; `runReport` (satırlar, `totals`, `propertyQuota`, `subjectToThresholding`, `dataLossFromOtherRow`, `dataTruncationReasons`, boş yanıt); 400 uyumsuz metrik, 401, 403 (izin / kapsam / API kapalı), 404, 429 (saatlik / günlük / eşzamanlı), 500, 503; `getMetadata` `deprecatedApiNames` | Kayıtlı fikstürler (`src/server/integrations/google/__fixtures__/`) + `vi.stubGlobal("fetch")` (repodaki desen) | CI         |
| Birim             | Hata kataloğu, akıllı iptal kararı, PII süzgeci, UTM oluşturucu, kalite bayrakları, taban ve anomali, ayrıştırmanın toplamı tutması, istatistik kapıları, tahmin, tatil takvimi, sağlık puanı, her MH/AN kuralının sınır değerleri                                                                                                                                                                            | Vitest, saf modüller. `.env` okunamıyorsa scratchpad'deki vitest yapılandırması                                 | CI         |
| Entegrasyon (DB)  | Kilit/CAS, grant paylaşımı ve 100 token koruması, Disconnect + 30 günlük silme, uyarı tekilleştirme, tarihli bulgu parmak izi, saklama temizliği, REVOKED koruması                                                                                                                                                                                                                                            | Tek kullanımlık yerel Postgres (Unix soketi tarifi); paylaşılan DB asla kullanılmaz                             | Yerel      |
| Arıza enjeksiyonu | Geri doldurma ortasında kotanın bitmesi, senkron ortasında `invalid_grant`, mülkün silinmesi, sunucu hatası sayacı                                                                                                                                                                                                                                                                                            | Sahte fetch + zamanlayıcı                                                                                       | CI / yerel |
| Uçtan uca         | Sahibin mülkünde: dünkü toplamlar GA arayüzüyle ±%1; kanal tablosu; key event'ler; izin kutusu kaldırılınca bağlanmama; Disconnect                                                                                                                                                                                                                                                                            | Gerçek mülk; yerel senkron yalnız `GA_SYNC_DEV_PROJECTS` ile                                                    | Yerel      |
| Zaman ve biçim    | Mülk saat diliminde gün anahtarı; yaz saati geçişleri (ör. Europe/Skopje, America/New_York); gece yarısı PST'deki kota sıfırlaması; rapor dilinde sayı biçimi (TR, EN, MK) ve number-check uyumu                                                                                                                                                                                                              | Saf testler, sabitlenmiş saat (`vi.setSystemTime`)                                                              | CI         |
| Gölge mod         | Analiz bulguları                                                                                                                                                                                                                                                                                                                                                                                              | `GA_INSIGHTS=shadow` ile 2 hafta; sahip 30 bulguyu inceler                                                      | Canlı      |
| Canlı doğrulama   | Uzlaştırma bekçisi, hata oranı, kota, nabız                                                                                                                                                                                                                                                                                                                                                                   | Günlük iş + /health                                                                                             | Canlı      |

Mevcut testler korunur: `meta-google-scopes.test.ts` (kapsam izolasyonu), `google-api-provider.test.ts`, `modules/analytics/*.test.ts`. GA tarafındaki `seo-rules.ts` testleri, kural kaldırılınca yeni modüle taşınır.

---

## 9. Fazlı yol haritası

Önerilen sıra: GA-F0 → GA-F1 → GA-F2 → GA-F3 → GA-F4 → GA-F5 → GA-F6 → (GA-F7) → GA-F8. Her fazdan sonra `docs/google-analytics.md` güncellenir. İlerleme raporlarında hangi ekranda neyin değiştiği yazılır (rota, kart adı, görünen metin, bayrak, migration).

**Kademeli açılış ve geri dönüş** (her faz için):

1. Önce yerelde mock modda ve tek kullanımlık DB'de denenir.
2. Canlıda bayrak açılır ama yalnız izin listesindeki projeler için (`GA_ROLLOUT_PROJECTS`, ör. sahibin ve test projeleri).
3. 48 saat /health izlenir: hata oranı, kota, nabız, uzlaştırma bekçisi. Eşik aşılırsa bayrak kapatılır.
4. Bir hafta sorunsuz geçerse izin listesi kaldırılır ve faz herkese açılır.
5. **Geri dönüş:** bayrak kapatılır, okuyucular eski canlı yola döner. Ambar verisi silinmez; bayrak yeniden açılınca senkron kaldığı yerden sürer. Migration'lar yalnız ekleme yaptığı için şema geri alınmaz.

### GA-F0 — Önkoşullar ve acil düzeltme · S

**Amaç:** Google tarafındaki engelleri erkenden görmek; koparılmış bağlantının geri gelmesini hemen kapatmak.

**Sahip adımları (kod dışı):**

1. Google Cloud Console → OAuth consent screen: yayın durumu "In production" mı? "Testing" ise refresh token'lar 7 günde düşüyor.
2. Data Access: `analytics.readonly` ve `webmasters.readonly` listede mi, hangi sınıfta görünüyor?
3. APIs & Services: Google Analytics Data API, Google Analytics Admin API ve Google Search Console API etkin mi?
4. Authorized domains, ana sayfa ve gizlilik politikası adresleri; Verification Center'daki doğrulama durumu.
5. GK1-GK6 ve GK12 kararları.

**Kapsam (kod):**

- **Yapıldı (6 Ekim, commit'siz):** `google-actions.ts`'te `testGoogleConnectionAction` ve `refreshGoogleListsAction` REVOKED bağlantıyı "connection not found" sayar (`meta-actions.ts` ile aynı desen). Durum yazımı `updateMany` + `status: { not: "REVOKED" }` ile yapılır; işlem sürerken gelen bir Disconnect kazanır. EXPIRED bağlantıyı ACTIVE'e yalnız başarılı bir refresh çevirir. Test: `src/server/actions/google-actions.test.ts` (4 test).
- Ortak altyapı burada yeniden kurulmaz: Meta F0b çalışma ağacında kodlandı (6 Ekim, commit'siz: `SystemHeartbeat` migration'ı `20261006120000_add_system_heartbeat`, `src/app/api/health/`, `src/server/observability/heartbeat.ts`). GA ve GSC yalnız kendi nabız anahtarlarını ekler (`ga.sync`, `gsc.sync`, `seo.crawl`).

**Migration:** Yok (`SystemHeartbeat` migration'ı Meta F0b'den geliyor).

**Kabul ölçütleri:**

- REVOKED bağlantıda Test ve liste yenileme reddediliyor ve durum değişmiyor (testli).
- Sahip Cloud ayarlarının durumunu raporladı.

**Bağımlılık:** Yok.

**Görünür değişiklik:** Koparılmış bir Google bağlantısında "Run Test" ve liste yenileme artık "Google Analytics connection not found" (ya da "Google Search Console connection not found") der ve bağlantıyı geri getirmez; yeniden bağlanmak için "Connect with Google" gerekir.

### GA-F1 — Bağlantı ve kimlik · M

**Durum (6 Ekim):** Bölüm 1 ve bölüm 2 yapıldı; uygulanan hâl [google-connections.md](google-connections.md)'de. Bölüm 1: ortak çekirdek, izin doğrulama, PKCE, hesap kimliği, Disconnect + akıllı iptal, roller, kiracıya özel sağlık, günlük bağlantı sağlığı, gizlilik ve veri silme metni. Bölüm 2: "Use existing connection", Connectors diyaloğunda `scope_missing` mesajı ve sağlık uyarıları, Search Console site/alan adı uyarısı, bağlı hesaplar kartında "yeniden bağlanmalı".

Uygulamada plandan farklar (GA-F2 ve sonrası bunlara göre yazılır):

1. **`GoogleGrant` tablosu yok.** 100 token sınırı, "Use existing connection"ın mevcut bağlantının şifreli refresh token'ını kopyalamasıyla çözüldü; şema değişmedi, `GOOGLE_GRANT_SHARING` bayrağı da yok. Hesap kimliği ve sağlık durumu `IntegrationCredential.metadata`'da (`googleSub`, `connectedEmail`, `googleHealth`); akıllı iptal aynı şifreli token, `googleSub` ya da e-postayla eşleştirir. Bu yüzden §4'teki `IntegrationCredential.grantId` ve `GaPropertyLink.grantId` / `GscSiteLink.grantId` kolonları **kurulmaz**; bağ tabloları yalnız `credentialId` taşır. Token sağlığı `google-grant-health` yerine `google-connection-health` adımıdır (bağlantı başına, günde bir).
2. **Eski `_ga`/`_gsc` çiftleri** taşınmadı: aynı şifreli token'ı paylaşan iki satır olarak çalışır; akıllı iptal onları birbirinin eşi sayar.
3. İlk mülk/site seçimini bağlantıyı kuran her üye yapabiliyor; değiştirmek, Disconnect ve "Use existing connection" OWNER/ADMIN istiyor.
4. Kabul ölçütündeki "3 projede tek refresh token", bağlantılar "Use existing connection" ile kurulduğunda geçerli (üç satır aynı token'ı taşır); her projede ayrı OAuth yapılırsa Google ayrı token verir.
5. Bağlı hesaplar kartı Türkçe kaldı (sağ panelin tamamı Türkçe). GA4 için alan adı uyarısı yok (mülk listesi alan adı taşımıyor). `pii.ts` ambarla birlikte GA-F2'ye kaldı; "Delete data now" ambar tablolarıyla gelir.

**Amaç:** Bağlantıyı doğru, ayrı, güvenli ve doğrulanabilir kılmak.

**Kapsam:**

- **Ortak çekirdek:** `src/server/integrations/google/{version,oauth,grant,access-token,revoke-policy,http,errors,error-catalog,pii}.ts` + `__fixtures__/` (Search Console planının SC-F1'iyle birlikte yazılır).
- **Callback** (`google/callback/route.ts`): PKCE, izin doğrulaması (`scope_missing`), Google kimliği, grant upsert, `IntegrationCredential.grantId`. `state_invalid` için `/dashboard` yerine okunabilir bir hata ekranı ya da toast.
- **Eylemler** (`google-actions.ts`): `requireProjectRole` (`tenant-context.ts`), "Use existing connection", Disconnect = token sil + akıllı iptal + 30 günlük silme planı, "Delete data now". Mülk seçimi listeye karşı doğrulanır ve alan adı uyarısı gösterilir.
- **Eski ortak token'lar:** ilk kullanımda `legacy_combined` grant'e tembel taşıma; Integrations notu.
- **Token sağlığı:** `google-grant-health` tick adımı; durumlar `GoogleTile` / `GoogleDialog`'a yansır.
- **Sağlık ayrımı:** `GoogleApiProvider`'ın sağlık anahtarı `google-analytics` olur; `error-classifier.ts`'e Google sınıfları eklenir; kiracı hataları `degradesProvider: false` ile işaretlenir.
- **Bağlı hesaplar kartı:** EXPIRED → "Needs reconnect"; metinler İngilizce.
- **Gizlilik:** `privacy/page.tsx`'e Google bölümü + Limited Use cümlesi, `LAST_UPDATED` güncellenir; `data-deletion/page.tsx`'e Google satırı.
- **Testler:** sözleşme fikstürleri, akıllı iptal tablosu, grant paylaşımı, rol.

**Migration:** `<ts>_add_google_grant` (`GoogleGrant` + `IntegrationCredential.grantId`).

**Bayrak:** Yok; bunlar hata düzeltmeleri ve sertleştirme. "Use existing connection" `GOOGLE_GRANT_SHARING=true` ile açılır.

**Kabul ölçütleri:**

- Onay ekranında GA kutusu kaldırılırsa bağlantı oluşmuyor ve kullanıcı açık bir mesaj görüyor (testli).
- Aynı Google hesabıyla aynı workspace'te 3 projeye bağlanınca DB'de tek refresh token var (testli).
- Disconnect token'ı siliyor. Aynı Google hesabının aktif bir Search Console bağlantısı varsa Google'da iptal çağrılmıyor, yoksa çağrılıyor (testli).
- `invalid_grant`, grant'e bağlı tüm GA bağlantılarını EXPIRED yapıyor ve uyarı açıyor.
- Bir müşterinin 403'ü global sağlığı değiştirmiyor (testli).
- Gizlilik sayfasında Limited Use cümlesi var; demo videosu çekilebilir durumda.

**Bağımlılık:** GA-F0.

**Görünür değişiklik:** Google Analytics diyaloğunda "Connected as …", izin eksikse "Needs permission", Disconnect sonrasında "Delete data now"; gizlilik sayfasında "Google Analytics and Search Console" bölümü.

**Sahip adımı:** Doğrulama başvurusu (demo videosu + gerekçe metinleri; metin taslaklarını plan uygulanırken hazırlarız).

### GA-F2 — Ambar ve kota yöneticisi · L

**Amaç:** GA verisini eksiksiz, tutarlı ve hızlı okunur hale getirmek; tüm okuyucuları tek kaynağa bağlamak.

**Kapsam:**

- `src/server/integrations/google-analytics/{data-api,admin-api,realtime,catalog,governor,fields}.ts`.
- `src/server/website-analytics/sync/*` ve `store.ts`; `ga-sync` tick adımı ve nabız.
- Mülk metadata'sı (Admin API) ve alan adı eşleşmesi.
- Okuyucuların geçişi: Analytics modülü (`modules/analytics/google.ts` → `store`), `GoogleApiProvider`, `findActiveGoogleConnections`.
- Analytics modülüne yeni metrikler ve bölümler (`report.ts` `METRIC_DEFS`, `facts.ts`, kart bileşenleri): kanallar, açılış sayfaları, key event'ler.
- "Website" sayfası v1 (`/projects/[projectId]/site`): KPI başlığı, trend, kanallar, açılış sayfaları, key event'ler, tazelik ve kalite notları; Explore menüsünden giriş; Brand sekmesinde "Website" kartı.
- `GoogleDialog`'da "Data through …" ve mülk kartı.
- `google-analytics-scanner.ts`'in GA kısmı `GA_SYNC` açıkken ambardan okur (GA-F4'te tamamen kalkar).
- `ga-retention` ve yerel geliştirme koruması.

**Migration:** `<ts>_add_ga_warehouse` (`GaPropertyLink`, `GaDailyTotal`, `GaReportSlice`, `GaMonthlySummary`).

**Bayraklar:** `GA_SYNC=true` (senkron + okuyucular), `GA_WEBSITE_PAGE=true`.

**Kabul ölçütleri:**

- Sahibin mülkünde kesinleşmiş günlerin toplamları GA arayüzüyle ±%1 tutuyor.
- 400 günlük geri doldurma, kotanın %10'unu aşmadan tamamlanıyor; kesilirse kaldığı yerden sürüyor.
- Günlük çekim günlerin %95'inde mülk saatiyle 18:00'e kadar tamamlanıyor.
- Analytics modül raporu GA bölümünü 1 saniyenin altında derliyor.
- Kota yöneticisi saatlik payı ve sunucu hatası sayacını uyguluyor (testli).
- Grant başına saatte en çok 1 token yenilemesi yapılıyor.
- Eşikleme ya da (other) olan tabloda not görünüyor.

**Bağımlılık:** GA-F1.

**Görünür değişiklik:** Yeni "Website" sayfası; Brand sekmesinde "Website" kartı; Analytics modül kartında kanal ve açılış sayfası tabloları; Integrations'ta "Data through Oct 5".

### GA-F3 — Ölçüm sağlığı denetimi · M

**Amaç:** Verinin doğruluğunu sürekli denetlemek ve sorunları sade dille düzelttirmek.

**Kapsam:**

- `src/server/website-analytics/health/*` (MH1-MH25); `ga-health` tick adımı.
- Uyarılar Meta'nın `AdsAlert` tablosuna yazılır (GK8); tekilleştirme, kendiliğinden kapanma ve susturma Meta tarafındaki uyarı koduyla paylaşılır. Telegram için sayı içermeyen metin.
- Site etiketi tespiti (`safe-fetch`).
- Ölçüm puanı: Integrations diyaloğu, Website sayfası paneli, Brand kartındaki nokta.
- Works "Needs attention" kartına GA uyarıları; sıradaki adım şeridine ölçüm adımları.
- Şüpheli günlerin işaretlenmesi (analiz tabanı için).

**Migration:** `<ts>_add_ga_health_and_alert_source` (`GaHealthCheck` + `AdsAlert.source` kolonu; yalnız ekleme).

**Bayrak:** `GA_HEALTH=true`.

**Kabul ölçütleri:**

- Her MH kontrolünün sınır değer testleri var.
- Tatbikat: test sitesinde etiket kaldırılınca ertesi gün MH1 CRITICAL; gün içinde realtime ile ≤ 3 saat.
- URL'sinde e-posta olan bir test sayfası MH12 CRITICAL üretiyor; değer ne ambarda ne de uyarı metninde görünüyor.
- Uyarı aynı koşulda tek satır kalıyor ve düzelince kendiliğinden kapanıyor.
- Telegram mesajında hiçbir GA sayısı yok (testli).

**Bağımlılık:** GA-F2.

**Görünür değişiklik:** "Measurement health 72/100" rozeti; Website sayfasında kontrol listesi ve rehberler; Works'te "Google Analytics stopped receiving data" kartı.

### GA-F4 — Analiz motoru · L

**Amaç:** Değişimleri nedenleriyle açıklamak ve fırsatları önceliklendirmek.

**Kapsam:**

- `src/server/website-analytics/analysis/*` (AN1-AN16), `GaFinding`, `ga-analyze` ve `ga-finding-evaluate` adımları.
- Sinyal (tarihli `externalRef`) ve fikir akışı (`idea-modules.ts`'e "website" kaynağı).
- Sohbet araçları (`tools.ts`'e dört araç, `MODULE_TOOLS.analytics`); `external: true`.
- `google-analytics-scanner.ts`'in GA kısmı ve `seo-rules.ts`'teki `DECLINING_TRAFFIC` kaldırılır (`GA_INSIGHTS=on` ile).
- Website sayfasında "What changed" ve "Opportunities" listeleri.
- Gölge mod listesi (sahip için, /health altında).

**Migration:** `<ts>_add_ga_finding`.

**Bayrak:** `GA_INSIGHTS=off|shadow|on`.

**Kabul ölçütleri:**

- Her kuralın sınır testleri var; ayrıştırmanın bileşenleri toplam değişime eşit (testli).
- Aynı sorun iki farklı haftada iki ayrı bulgu üretiyor (testli).
- Gölge modda 30 bulguluk örnekte isabet ≥ %70.
- Sohbette "Why did leads drop last week?" sorusu ambardaki sayılarla ve number-check'ten geçerek yanıtlanıyor.
- Tatil günü anomali üretmiyor (testli).

**Bağımlılık:** GA-F3.

**Görünür değişiklik:** Website sayfasında "What changed" ve "Opportunities"; Analytics sohbetinde GA soruları anında yanıtlanıyor; fikir panosunda "From your website" kanıtlı fikirler.

### GA-F5 — Raporlama ve planlama · M

**Amaç:** Profesyonel bir ritimde rapor ve hedefe bağlı plan.

**Kapsam:**

- `src/server/website-analytics/reports/{pulse,weekly,monthly,forecast,goals}.ts`.
- "Website analytics" sohbeti (`wkga_<projectId>`) ve saklanan rapor kartları; `page.tsx` sohbet sorgusuna yeni kart türü.
- Dışa aktarma: Analytics modülünün `export.ts` ve `share.ts`'i (Markdown, yazdırma/PDF).
- `ProjectGoal.currentValue` yazımı, tempo, tahmin ve "Next month plan" kartı.
- Settings: rapor günleri ve uyarı tercihleri.

**Migration:** Yok.

**Bayrak:** `GA_REPORTS=true`.

**Kabul ölçütleri:**

- Haftalık rapor Pazartesi proje saatiyle çıkıyor; özetteki her sayı ambara dayanıyor (number-check testleri).
- Gönderilmiş bir rapor kartı sonraki GA revizyonlarıyla değişmiyor.
- Hedeflerin `currentValue` değeri her gün güncelleniyor.
- Tahminin geriye dönük testinde sahibin mülkünde ay sonu hatası ≤ %20 (doğrulanmalı).
- Aylık rapor Markdown ve yazdırma olarak dışa aktarılabiliyor.

**Bağımlılık:** GA-F4 (rapor bulgu açıklamalarını kullanır; KPI bölümü GA-F2 ile de çalışır).

**Görünür değişiklik:** Projede "Website analytics" sohbeti; Pazartesi günü "Weekly website report" kartı; Brand Brain → Goals'ta canlı ilerleme ve "At risk" etiketi.

### GA-F6 — Kapalı döngü ve reklam ölçümü · M

**Amaç:** Agentelse'in içerik ve reklamlarının sitede ne getirdiğini görünür kılmak; reklam kararlarına bağımsız kanıt sağlamak.

**Kapsam:**

- `src/lib/utm.ts` ve `TrackedLink`. Uygulandığı yerler: Meta reklam kreatifleri (`url_tags`; Meta Ads planındaki P11), Facebook link postları (link özelliği geldiğinde), bio linki üretici, diğer kanallar.
- Settings → "Add tracking (UTM) to links".
- `src/server/website-analytics/attribution/*`: `campaign` dilimlerinin `TrackedLink`'e bağlanması ve "From Agentelse" bölümü.
- AN12-AN14 ve `getGaOutcomesForCampaign` okuma API'si (Meta optimizasyonuna kanıt).
- GA tabanlı "Cost per key event" (Meta ambarı varsa).
- `BrandLearning` yazımı (`sourceType = "GA4"`).

**Migration:** `<ts>_add_tracked_link`.

**Bayrak:** `GA_UTM=true`.

**Kabul ölçütleri:**

- Agentelse'in oluşturduğu her reklam linki UTM taşıyor; sitenin kendi iç linkleri taşımıyor; mevcut UTM korunuyor (testli).
- `agx-` kampanyalı GA satırları doğru varlığa bağlanıyor (testli).
- Öğrenme yalnız kapıyı geçen sonuçtan yazılıyor.
- Meta ile GA arasındaki fark etiketli ve yan yana gösteriliyor.

**Bağımlılık:** GA-F2 (Meta çapraz kontrolü için ayrıca Meta Ads planının F2'si).

**Görünür değişiklik:** Website sayfasında "From Agentelse"; haftalık raporda "Your ads on your website"; Ads modülünün Review adımında "Tracking: UTM added".

### GA-F7 — Düzeltme eylemleri (`analytics.edit`) · M · isteğe bağlı

**Amaç:** Sık görülen yapılandırma sorunlarını, kullanıcının onayıyla tek dokunuşta düzeltmek.

**Kapsam:**

- **Artımlı onay:** grant'in izinleri `analytics.readonly analytics.edit` olarak yükseltilir (ayrı onay ekranı; doğrulamaya yeni izin eklenir).
- **Eylemler (Admin API):**
  - key event işaretleme (`properties.keyEvents.create`, v1beta),
  - olay verisi saklamayı 14 aya çıkarma (`updateDataRetentionSettings`, v1beta),
  - "AI assistants" özel kanal grubu (`channelGroups`, v1alpha),
  - Agentelse notları (`reportingDataAnnotations`, v1alpha; ör. "Agentelse: Spring campaign launched"),
  - site aramasını açma (`enhancedMeasurementSettings`, v1alpha).
- **Değişiklik geçmişi:** `searchChangeHistoryEvents` yalnız `analytics.edit` ile çalışır. GA'da elle yapılan değişiklikler (ör. bir key event'in kaldırılması) tespit edilir ve uyarı açılır.
- Her eylem Task + Approval (OWNER/ADMIN) üzerinden çalışır; `GaConfigChange` kaydı, geri okuma ve mümkünse geri alma vardır.
- Unwanted referrals ve alan adları arası ölçüm API'de yok; bunlar rehberle kalır (doğrulanmalı).

**Migration:** `<ts>_add_ga_config_change`.

**Bayrak:** `GA_FIXES=true`.

**Kabul ölçütleri:**

- Onaysız hiçbir yazma yapılmıyor (testli).
- Her yazma geri okunuyor.
- v1alpha uçları için sözleşme testi ve kapatma bayrağı var.

**Bağımlılık:** GA-F3 + doğrulamaya `analytics.edit` izninin eklenmesi.

**Görünür değişiklik:** Ölçüm rehberlerinde "Fix it for me (needs approval)".

### GA-F8 — Ajans ve ileri ölçek · L

**Amaç:** Çok müşterili ajansın tek yerden yönetimi ve büyük mülkler.

**Kapsam:**

- Proje başına birden çok mülk (`GaPropertyLink.primary`), ör. ayrı bir mağaza mülkü.
- Workspace genelinde "Websites" görünümü: bütün müşterilerin KPI'ları ve ölçüm sağlığı.
- Beyaz etiketli müşteri raporu (ajans logosu ve adı) ve zamanlanmış paylaşım bağlantısı.
- Şifreleme anahtarı sürümü (`keyId`); RISC ile anında iptal bildirimi.
- İsteğe bağlı: BigQuery dışa aktarımını okuma (müşterinin kendi projesi; yeni izin ve doğrulama gerekir), huni raporu (`runFunnelReport`, v1alpha), 360 kotaları.
- Kullanılmayacak: Data API'nin doğal dil ucu `properties.chat` (ayrı izin ister; analiz bizim motorumuzda yapılıyor).

**Migration:** `<ts>_add_ga_agency` (gerektiği kadar).

**Bayrak:** `GA_AGENCY=true`.

**Kabul ölçütleri:**

- Bir grant 20 projeye bağlanabiliyor.
- Ajans görünümü 20 mülkü listeliyor.
- Beyaz etiketli rapor dışa aktarılabiliyor.

**Bağımlılık:** GA-F5.

---

## 10. Riskler ve azaltımlar

| Risk                                                      | Olasılık / etki | Azaltım                                                                                                                                                                           |
| --------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Doğrulama gecikir; 100 kullanıcılık ömür boyu sınır dolar | Orta / yüksek   | GA-F1 biter bitmez başvuru; demo senaryosu ve gerekçe metinleri hazır. Doğrulamaya kadar yeni bağlantılar sayılır, 80'e gelince sahip uyarılır                                    |
| "Testing" durumunda 7 günlük token                        | Orta / orta     | GA-F0'da kontrol; token sağlığı "Needs reconnect"i 24 saat içinde gösterir                                                                                                        |
| Google'da iptalin iki servisi birden koparması            | Orta / orta     | Akıllı iptal (testli); kullanıcıya açık not. Tek proje kararı (GK1) nedeniyle Google hesabından kaldırma iki servisi birlikte düşürür; token sağlığı bunu 24 saat içinde gösterir |
| 100 refresh token sınırı (ajans)                          | Orta / yüksek   | Workspace grant'i ve "Use existing connection"                                                                                                                                    |
| Proje↔mülk sunucu hatası bloğu (saatte 10)                | Düşük / orta    | 500/503'te en çok 1 tekrar; saatte 3 hatada P2 durur                                                                                                                              |
| GA verisinin sonradan değişmesi (geç veri, atıf)          | Yüksek / orta   | 7/13 günlük revizyon, "Preliminary" etiketi, gönderilmiş raporun anlık görüntüsü                                                                                                  |
| Yanlış alarm (tatil, sezon, bot)                          | Orta / orta     | Haftanın günü tabanı, tatil takvimi, şüpheli gün dışlama, gölge mod, asgari hacim                                                                                                 |
| URL'deki kişisel verinin ambara ya da LLM'e girmesi       | Düşük / yüksek  | Depolamadan önce PII süzgeci; MH12 yalnız parametre adı ve sayı gösterir                                                                                                          |
| Referrer spam ile prompt injection                        | Düşük / orta    | Araçlar `external: true`; temizleme, kırpma ve veri bloğu                                                                                                                         |
| LLM'in sayı uydurması                                     | Düşük / yüksek  | number-check; LLM'e yalnız kanıttaki sayılar gider                                                                                                                                |
| Hukuki: kalıcı kopya ve AI işleme                         | Düşük / yüksek  | Bağlanırken açık beyan, gizlilik metni, "Delete data now", eğitim yok; hukuki görüş (doğrulanmalı)                                                                                |
| v1alpha uçlarının değişmesi                               | Orta / düşük    | Yalnız GA-F7 ve GA-F8'de; ayrı bayrak; sözleşme testleri                                                                                                                          |
| Metrik adlarının kaldırılması (`deprecatedApiNames`)      | Orta / orta     | Haftalık `getMetadata` kontrolü ve operatör uyarısı                                                                                                                               |
| Ambarın büyümesi                                          | Orta / düşük    | Kompakt dilimler, satır sınırları, saklama işi; 100 mülkte ~0,5-1 GB                                                                                                              |
| Yerelden canlı kotanın tüketilmesi                        | Düşük / orta    | `GA_SYNC_DEV_PROJECTS` izin listesi                                                                                                                                               |
| Paylaşılan DB'de migration                                | Orta / yüksek   | Yalnız ekleme; faz başına yeni klasör; tek kullanımlık yerel DB'de üretim                                                                                                         |
| Karmaşıklık artışı                                        | Orta / orta     | Faz başına bayrak; KOBİ'de altı KPI; uzman metrikleri gizli                                                                                                                       |

---

## 11. Sahibin vermesi gereken kararlar

| #    | Karar                                              | Seçenekler                                                                                                                                                                                                              | Önerilen                                                                                         | Gerektiği faz |
| ---- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------- |
| GK1  | Google Cloud projesi                               | (a) Tek proje + akıllı iptal; (b) GA ve Search Console için iki ayrı Cloud projesi (ikinci doğrulama, ikinci env çifti, mevcut GSC kullanıcılarının yeniden bağlanması). İki seçenekte de arayüzde ayrı ayrı bağlanılır | **Karar verildi (6 Ekim): (a).** Ayrı bağlanma, tek proje, tek doğrulama; ikinci doğrulama yok   | GA-F1         |
| GK2  | Eski ortak token'lar                               | (a) `legacy_combined` grant'e taşınsın, çalışmaya devam etsin, isteğe bağlı "Reconnect to separate"; (b) yeniden bağlanma zorunlu olsun                                                                                 | (a)                                                                                              | GA-F1         |
| GK3  | Disconnect                                         | (a) Token hemen, veri 30 gün sonra silinsin ("Delete data now" ile hemen); (b) her şey hemen silinsin                                                                                                                   | (a)                                                                                              | GA-F1         |
| GK4  | Saklama                                            | (a) Toplam ve kanal 400 gün; sayfa, kaynak ve kampanya günlük 95 + haftalık 400 gün; aylık özet 36 ay; (b) yalnız 95 gün                                                                                                | (a) + gizlilik metni ve bağlanma beyanı. Instagram organik için "sayı saklamama" kararı değişmez | GA-F2         |
| GK5  | Grant paylaşımı                                    | (a) Aynı workspace'te aynı Google hesabı için tek token; "Use existing connection" OWNER/ADMIN'de; (b) her proje kendi token'ı                                                                                          | (a)                                                                                              | GA-F1         |
| GK6  | Roller                                             | (a) Connect her üye; mülk değiştirme, Disconnect, veri silme, grant paylaşımı OWNER/ADMIN; (b) herkes her şeyi yapabilsin                                                                                               | (a)                                                                                              | GA-F1         |
| GK7  | Kritik uyarı kanalı                                | (a) Uygulama içi + sayı içermeyen Telegram; (b) yalnız uygulama içi; (c) + e-posta (yeni bağımlılık)                                                                                                                    | (a); e-posta sonra                                                                               | GA-F3         |
| GK8  | Uyarı tablosu                                      | (a) Meta'nın kurduğu `AdsAlert`'i ortak kullanmak + boş olabilen `source` kolonu; (b) yeni ve ayrı bir `MonitorAlert` tablosu; (c) entegrasyon başına ayrı tablo                                                        | (a): Works "Needs attention" tek tablodan okur, ikinci uyarı tablosu olmaz                       | GA-F3         |
| GK9  | Raporların yeri                                    | (a) Proje başına "Website analytics" sohbeti; (b) yalnız Website sayfası                                                                                                                                                | (a) + sayfada arşiv                                                                              | GA-F5         |
| GK10 | UTM                                                | (a) Agentelse'in dış linklerinde varsayılan açık, Settings'ten kapatılabilir; (b) varsayılan kapalı                                                                                                                     | (a)                                                                                              | GA-F6         |
| GK11 | LLM'e giden veri                                   | (a) Yalnız toplulaştırılmış sayılar + maskelenmiş ilk 20 sayfa yolu; (b) LLM hiç kullanılmasın                                                                                                                          | (a)                                                                                              | GA-F4         |
| GK12 | Doğrulama zamanı                                   | (a) GA-F1 canlıya çıkınca; (b) GA-F2'den sonra                                                                                                                                                                          | (a), ömür boyu 100 kullanıcı sınırı nedeniyle                                                    | GA-F1         |
| GK13 | GA-F7 (`analytics.edit`)                           | (a) GA-F5'ten sonra, talep olursa; (b) hemen. İki durumda da aynı projenin doğrulamasına ek bir izin incelemesi gerekir (ikinci proje doğrulaması değil)                                                                | (a); istenmezse GA salt okunur kalır                                                             | GA-F7         |
| GK14 | Website sayfasının yeri                            | (a) `/projects/[id]/site`; Explore menüsü + Brand kartı; (b) yeni bir dok sekmesi                                                                                                                                       | (a); dok sade kalır                                                                              | GA-F2         |
| GK15 | Yerel geliştirmede senkron                         | (a) Kapalı, yalnız izin listesindeki projeler; (b) açık                                                                                                                                                                 | (a)                                                                                              | GA-F2         |
| GK16 | agentelse.com'a GA4 (kendi ürünümüzü denemek için) | (a) Evet, çerez onayıyla; (b) hayır                                                                                                                                                                                     | (a); test mülkü olur                                                                             | GA-F0         |
| GK17 | Rapor dili                                         | (a) Arayüz İngilizce, rapor ve özet metni projenin içerik dilinde; (b) her şey İngilizce                                                                                                                                | (a); ajansın müşteri raporu müşterinin dilinde çıkar                                             | GA-F5         |

---

## 12. Search Console ile ilişki (iki ayrı entegrasyonun köprüsü)

**Bağımsızlık kuralları:**

- GA, Search Console bağlı olmadan eksiksiz çalışır; Search Console da GA olmadan. Hiçbir GA ekranı, işi ya da kuralı Search Console verisine bağımlı değildir.
- İzin, token (grant), tablolar, işler, sağlık, bayraklar, Disconnect ve silme ayrıdır. Bir entegrasyonun kopması diğerini etkilemez (Google tarafındaki ortak izin kaydı istisnası §3.2'de ele alındı).
- Ortak olan yalnız kod çekirdeği (§3.1), `MonitorAlert`, `SystemHeartbeat` ve ürün döngüsüdür (Signal, Idea, Goal, BrandLearning).

**Köprü.** Yalnız iki entegrasyon da aynı projede bağlıysa ve alan adları eşleşiyorsa çalışır; köprü kodu Search Console planında yaşar.

- GA bir okuma API'si sağlar: `getLandingPageOutcomes(projectId, range)` → açılış sayfası başına organik Google oturumu, etkileşim oranı, key event oranı, gelir.
- Search Console planı bunu üç yerde kullanır:
  1. SEO fırsatlarını tıklama yerine **değerle** önceliklendirme ("Bu sayfa 3. sıraya çıkarsa ayda ~40 ek ziyaret ve ~2 lead").
  2. GSC tıklamasıyla GA organik oturumu arasındaki farkın **eğiliminden** izleme ya da çerez onayı kaybı tespiti (fark düzeyi normaldir; ani değişimi bulgudur).
  3. SEO eylemlerinin değerlendirmesinde dönüşüm etkisi.
- GA'daki AI asistan trafiği (AN7), Search Console planının AI arama görünürlüğü (GEO) bölümüne sinyal olarak gider.
- GA4'ün kendi Search Console bağlantısı varsa (`organicGoogleSearch*` metrikleri; 48 saat gecikme, 16 ay, yalnız açılış sayfası, ülke ve cihaz boyutlarıyla), Agentelse'in Search Console entegrasyonu bağlı olmasa bile açılış sayfası düzeyinde organik görünürlük gösterilebilir. Sorgu düzeyindeki veri yalnız Search Console API'sinden gelir.

---

## Ek A. Temel Google kaynakları

- **Data API:** [REST](https://developers.google.com/analytics/devguides/reporting/data/v1/rest) · [Değişiklik günlüğü](https://developers.google.com/analytics/devguides/reporting/data/v1/changelog) · [Kotalar](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas) · [ResponseMetaData](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/ResponseMetaData) · [API şeması](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema) · [İleri kullanım](https://developers.google.com/analytics/devguides/reporting/data/v1/advanced) · [MetricMetadata](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/MetricMetadata)
- **Admin API:** [REST](https://developers.google.com/analytics/devguides/config/admin/v1/rest) · [Değişiklik günlüğü](https://developers.google.com/analytics/devguides/config/admin/v1/changelog) · [searchChangeHistoryEvents](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/accounts/searchChangeHistoryEvents) · [runAccessReport](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/properties/runAccessReport) · [DataRetentionSettings](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1beta/DataRetentionSettings) · [AttributionSettings](https://developers.google.com/analytics/devguides/config/admin/v1/rest/v1alpha/AttributionSettings)
- **GA Yardım:** [Veri tazeliği](https://support.google.com/analytics/answer/11198161) · [(other) satırı](https://support.google.com/analytics/answer/13331684) · [Eşikler](https://support.google.com/analytics/answer/9383630) · [Raporlama kimliği](https://support.google.com/analytics/answer/10976610) · [Atıf modelleri](https://support.google.com/analytics/answer/10596866) · [Atıf ayarları](https://support.google.com/analytics/answer/10597962) · [Veri saklama](https://support.google.com/analytics/answer/7667196) · [Search Console bağlantısı](https://support.google.com/analytics/answer/13682863) · [Data Controls](https://support.google.com/analytics/answer/17016975)
- **OAuth ve politika:** [OAuth 2.0 genel bakış (100 token sınırı)](https://developers.google.com/identity/protocols/oauth2) · [Web sunucusu akışı](https://developers.google.com/identity/protocols/oauth2/web-server) · [Granüler izinler](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions) · [İzinler](https://developers.google.com/identity/protocols/oauth2/scopes) · [Hassas izin doğrulaması](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) · [Doğrulama gereksinimleri](https://support.google.com/cloud/answer/13464321) · [Doğrulama SSS](https://support.google.com/cloud/answer/13463817) · [Doğrulanmamış uygulamalar](https://support.google.com/cloud/answer/7454865) · [En iyi uygulamalar](https://developers.google.com/identity/protocols/oauth2/resources/best-practices) · [API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy) · [Google APIs Terms of Service](https://developers.google.com/terms) · [Workspace API User Data Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) · [RISC](https://developers.google.com/identity/protocols/risc)

## Ek B. Kısaltmalar

- **Ambar:** GA4'ten çekilen toplulaştırılmış verinin yerel kopyası.
- **CAS:** compare-and-swap; yalnız beklenen değer hâlâ geçerliyse yazma.
- **CRO:** dönüşüm oranı optimizasyonu.
- **Grant:** Google hesabının Agentelse'e verdiği erişim; bizde bir `GoogleGrant` satırı.
- **KE:** key event.
- **MAD:** medyan mutlak sapma.
- **P1 / P2:** kullanıcı işi / arka plan senkronu öncelik şeritleri.
- **PII:** kişiyi tanımlayan veri.
- **UTM:** linke eklenen kampanya parametreleri (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`).
- **WoW / MoM / YoY:** haftadan haftaya / aydan aya / yıldan yıla.
