# Meta Ads otonomisi: temel katman (7 Eki 2026)

Amaç: reklam sistemi hedeflere kanıtla yaklaşsın; tam otonomi bu temelin
üstüne, kanıt biriktikçe açılsın. Bu belge hem yapılanı hem sıradakini yazar.
Genel tasarım (seviyeler L0-L4, yetki sözleşmesi, devre kesiciler) sahiple
konuşuldu; burada yalnız koda inen kısım var.

## Seviyeler

| Seviye            | Ne yapar                                                   | Durum                  |
| ----------------- | ---------------------------------------------------------- | ---------------------- |
| L0 İzle           | okur, raporlar                                             | var                    |
| L1 Öner (shadow)  | kararını kaydeder, uygulamaz (`META_ADS_OPTIMIZER=shadow`) | var                    |
| L2 Korumalı       | yalnız riski azaltır (duraklat, en fazla %30 kıs)          | var                    |
| L3 Sınırlı otonom | yetki sınırı içinde bütçe artırır, reklam döndürür         | YOK, bu temelden sonra |
| L4 Tam otonom     | plandan kampanya açar, test yürütür                        | YOK                    |

## Yapılan temel (bayraksız, davranış güvenli)

### 1. Fikirden reklama soy bağı + nitelik etiketleri

Her reklam, lansman spec'inde (`spec.ads[].lineage`) şunları taşır:

- `creativeIds`: reklamın postları (carousel'de hepsi), `ideaIds`: bu postların
  fikirleri (Creative → Post → Idea zinciri, `server/ads/lineage.ts`),
- `angle`: fikrin açısı (hipotez),
- `tags`: metinden ve biçimden çıkan etiketler (`lib/ads/lineage.ts`): `format`
  (image/video/carousel), `hook` (question, number, urgency, proof, how-to,
  benefit, statement), `offer` (discount, free, price, none), `length`, `cta`,
  `pillar`, `ideaSource`.

Etiketler kural tabanlıdır (TR + EN kalıplar): kesin değil, tutarlıdır; aynı
kanca tipi hep aynı etiketi alır. Soy bağı Review'da hesaplanır, onaylı spec ile
saklanır (`specHash`'e girmez, yani onayı bozmaz). Migration yok: `AdsLaunch.spec`
JSON'unun içinde.

### 2. Nitelik düzeyinde öğrenme (Brand Brain'e geri akış)

`server/ads/reports/lineage-learnings.ts`, haftalık rapor turunda
(`AdsReports.runDue`) çalışır: son 28 gün, reklam başına harcama ve sonuç;
etiket değeri ile "diğerleri" aynı tarif içinde karşılaştırılır
(`lib/ads/lineage-stats.ts`). Kapı: her iki tarafta en az 10 sonuç ve 2 reklam,
sonuç oranında log-oran z ≥ 1,96 (%95) ve en az %15 fark. Geçen bulgu
`BrandLearning` olur (`sourceType META_ADS_LINEAGE`, kararlı `sourceRef`, her
hafta aynı satır güncellenir, polarity WORKS/AVOID).

Brand Twin bu satırları "ne işe yarıyor / kaçın" belleği olarak fikir motoruna ve
kreatif brieflerine zaten verir; yeni bağlantı gerekmedi.

Sınır: bu bir gözlemsel karşılaştırmadır, deney değildir. Reklamlar hedef kitle,
saat ve bütçe bakımından birbirinden farklı olabilir. Bu yüzden bulgular
"işe yarıyor" değil "daha ucuza getirdi" diye yazılır; kesin neden-sonuç için
sıradaki adım kontrollü test (aşağıda).

### 3. Marka kapısı

`server/ads/brand-gate.ts`, Review ön kontrolünde (`prepareLaunch`) çalışır:

- Marka kurallarından ("asla yapma": yasak iddialar + negatif brief) kısa
  ifadeler reklam metninde kelime sınırında geçiyorsa **engel** (`BRAND`).
- Anlamsal denetim (onaysız iddia) mevcut `creativeClaimCheckDef` ile tek
  çağrıdır, 10 dk saklanır. İnsan onaylı lansmanda **uyarı**; `strict: true`
  (insansız otonomi için) ile **engel** ve denetim çalışamazsa da engel.

## Sıradaki adımlar (sırayla, her biri bayrakla kapalı gelecek)

1. **Shadow ölçümü (4 hafta):** optimizer kararları `AdsDecision` olarak SHADOW
   yazılıyor; "bu karar uygulansaydı" sonucu sonradan okunur ve gerçekte ne
   olduğuyla karşılaştırılır. Terfi kapısı: kararların isabet oranı ve insanın
   gerçek kararına karşı sonuç farkı.
2. **Kontrollü test (deney):** havuzdaki bir fikir tek değişkenli hipotez olarak
   bütçenin küçük diliminde (%10-20) denenir; kazanan istatistik kapısıyla seçilir.
3. **L3:** yetki sözleşmesi `ProjectGoal`'dan türer; olgun kampanyalarda
   sınırlı bütçe artırma, öğrenme evresi koruması, devre kesiciler, veto penceresi.
4. **L4:** plandan otonom kampanya, kreatif yenileme (yorgunluk → fikir motoru).

Başarı için sistem dışı koşullar: doğru ölçüm (pixel + Conversions API),
gerçek başa baş hedef, yeterli bütçe (ad set başına haftada kabaca 50 sonuç).
