# Marka kiti: site tarama, kurumsal kimlik, post layout'ları

Sağ paneldeki **Brand** sekmesi görsel bir marka kitidir (logo, rol etiketli renk paleti, fontlar, fotoğraf stili, post layout'ları). Web sitesinin yanındaki **Scan site** butonu siteyi tarar, kurumsal kimliği çıkarır ve bir modalda onaya sunar. Onaylanan kimlikten **post layout'ları** (logo/renk şeridi/başlık yerleşimi) türer; sohbet, Studio ve haftalık planlayıcı görseli bu layout'a göre üretir.

## 1. Site tarama

Modal (`brand-scan-dialog.tsx`) üç adımdır: **URL** → **Bulunanlar** (logo, renkler, fontlar, stil/mood, layout galerisi; hepsi düzenlenebilir) → **Apply**.

- `scanBrandWebsiteAction` (`brand-scan-actions.ts`) **hiçbir şey kaydetmez**; sonucu döner. Kullanıcı başı dakikada 4 tarama.
- `applyBrandScanAction` kullanıcının onayladığı içeriği kaydeder: `BrandVisualIdentity` (renk rolleri, stil, mood, şablon, `layoutTemplates`), `BrandDossier.approvedFonts` ve logo (`Asset(LOGO)`), `Project.domain`. Yük sıkı doğrulanır (hex regex, boyut, logo `sharp` ile yeniden kodlanır).
- **Güvenlik (SSRF):** `src/server/security/safe-fetch.ts`. Yalnız http/https; DNS **bağlantı anında** doğrulanır (özel, loopback, link-local, CGNAT, metadata IP'leri v4+v6 reddedilir, DNS-rebinding'e karşı özel `lookup`); yönlendirmeler elle izlenir ve her adımda yeniden doğrulanır (en çok 4); 10 sn zaman aşımı; gövde tavanları HTML 2 MB, CSS 500 KB, manifest 100 KB, görsel 3 MB.
- **Çıkarım** (`src/server/brand/site-scan/`): `extract.ts` HTML/CSS'ten başlık, açıklama, `theme-color`, ikon/manifest, logo adayları, renk sıklığı, `font-family` ve Google Fonts'u bağımsız çıkarır (nötr renkler elenir, benzerler kümelenir). `image-colors.ts` logoyu doğrular (≤512 px PNG), **şeffaf kenar boşluğunu kırpar**, baskın renkleri örnekler ve logonun tonunu (açık/koyu) piksellerden bulur. `scan.ts` hepsini yönetir; OpenAI (`brandSiteScanDef`, `prompts/brand-site-scan.ts`) yalnızca **çıkarılan aday hex'ler arasından** rol atar ve stil/mood önerir (aday dışı hex'ler kodla en yakın adaya oturtulur).
- **Logo yuvası** tona göre seçilir: açık renkli logo `BrandDossier.logoAssetId` (koyu zemin için), koyu renkli logo `darkLogoAssetId` (açık zemin için). Uygulamanın tüm logo mantığı bu iki yuvaya dayanır.
- JS ile çizilen (SPA) siteler boş HTML döndürebilir: manifest/og/theme-color ile "sınırlı veri" uyarısı verilir, kalanı elle düzenlenir.

## 2. Brand sekmesi

`workspace-right-panel-data.ts` markanın kimliğini `buildBrandKit` (`src/lib/brand-kit.ts`) ile düz, serileştirilebilir bir `BrandKit` nesnesine çevirir; sağ panelin Marka sekmesi (`brand-summary-panel.tsx`) beş kart çizer.

Her kartın başlığında küçük bir ikon vardır (`card-title.tsx`), sıra en çok kullanılandan başlar:

1. **Bağlı hesaplar** (en üstte, `brand-overview-cards.tsx`): yalnız gerçekten bağlı hesaplar (`state === "connected"`), tek sıra gerçek marka logosu (`integrations/brand-icons.tsx`). Kurulumu yarım kalan (GA4 property / Search Console sitesi seçilmemiş), bağlı olmayan hesaplar ve Website (hesap değil; adresi özette) gösterilmez. İpucu "Instagram · @handle"; "Yönet" Integrations sayfasına gider. Hiç bağlı yoksa "Henüz bağlı hesap yok. Hesap bağla". Durumları `src/server/integrations/connected-accounts.ts` okur.
2. **Marka özeti**: logo, ad, site; ikonlu Sektör / Hedef kitle / Ses tonu / Pazarlar satırları (boş olan satır hiç görünmez) ve en çok beş renk; "Düzenle" Brand Brain'e gider.
3. **Instagram** (yalnız bağlıyken): profil + takipçi, son 28 gün erişim / görüntülenme, etkileşim oranı, son 3 gönderi.
4. **Marka kiti** (kapalı kart; kimlik boşsa açık): logo kutuları (her varyant kendi zemininde), palet (tıkla-kopyala), font örnekleri, stil çipleri, layout galerisi (+ **Edit layouts**), **Scan site**. Kimlik boşsa büyük bir "Scan my website" kartı görünür.
5. **Marka stratejisi** (kapalı kart): Marka özü, Şu anki odak, İşe yarayanlar, Asla yapma. Ses tonu ve pazarlar özette olduğu için burada tekrar edilmez.

Sayfanın tepesindeki renkli "hero" kartı ve "Agentelse fark etti" kartı yoktur (tasarımda bilerek çıkarıldı).

## 3. Post layout'ları

`BrandVisualIdentity.layoutTemplates` (`Json?`): `{ version: 1, defaultId, items[] }`, en çok 12. Şema ve yardımcılar `src/lib/layout-templates.ts`:

| Alan          | Anlam                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `formats`     | Uygun olduğu oranlar: `portrait` (Post 3:4), `square`, `landscape`, `vertical` (Story/Reel 9:16); boş = hepsi. |
| `logo`        | Konum (4 köşe, alt orta, üst orta), boyut %, kenar boşluğu %, `onBand` (logo şeridin içinde).                        |
| `bar`         | Kapalı / ince çizgi (`line`) / opak marka bandı (`band`); konum, yükseklik %, renk (rol ya da `#rrggbb`).      |
| `headline`    | Bölge (üst, sol üst, orta, sol sütun, alt), hiza, en çok satır, ölçek. Yazıyı **bizim kompozitimiz dizer** (`creative-text.ts`). |
| `composition` | Görüntü modeline sahne yönergesi ("özneyi alt üçte ikide tut, üst üçte biri sakin bırak").                     |

`buildPresetLayouts(base)` markanın mevcut şablon ayarından **deterministik** 7 hazır layout üretir (Classic, Headline on top, Left column, Center statement, Brand band, Story / Reel, Image only); LLM yoktur. Galeri (`layout-gallery.tsx`) canlı CSS önizlemesi (`layout-preview.tsx`, gerçek logo ve renklerle, kompozitle aynı yüzdelerle) gösterir; kullanıcı düzenler, çoğaltır, hazır haline sıfırlar, siler ve varsayılanı seçer. **Bir layout kartına tıklamak onu yeni postların varsayılanı yapar** (`setDefaultLayout`; seçili kart ve "Default" rozeti aynı yerde olur; eskiden tıklama yalnızca düzenleme için seçiyordu ve ayrı bir "Use as default" düğmesi gerekiyordu, bu yüzden kaydedilen "seçim" hiçbir şeyi değiştirmiyordu). Varsayılan bir post şekli için uygun değilse o şekil, o şekle göre yapılmış layout'u alır; galeri bunu varsayılanın yanında söyler (`defaultOverrides`). Kayıt: `updateLayoutTemplatesAction`. Mevcut postlar layout'unu korur; yalnızca yeni üretimler değişen varsayılanı izler.

**Nasıl uygulanır** (`src/server/media/creative-layout.ts`, `planCreativeLayout`): layout id verilmişse o; yoksa marka varsayılanı (formata uygunsa); uygun değilse tam o format için yapılmış layout; o da yoksa formata uyan ilk layout seçilir (`resolveLayout`). Sonuç üç şeydir:

1. **Kesin kompozit:** `layoutToTemplateConfig` → `applyBrandTemplate`. Logo, şerit ve bant görüntü üretildikten **sonra** piksel-hassas eklenir (yapay zekâ çizmez). Bantta logo, bant rengine göre doğru varyantla (açık/koyu) bandın içine oturur; Story/Reel'de köşe logosu platformun kendi arayüz bantlarından (`safeZone`) uzak tutulur; layout kullanılırken logonun boş kenarları kırpılır (`trimLogo`), böylece "boyut %" ve "kenar boşluğu" görünen işarete uygulanır.
2. **Prompt:** `reservedZones` (kompozitin kaplayacağı alanlar, yazıdan ve ana özneden boş bırakılır), `layoutComposition` (sahne yönergesi) ve yazı varsa `textArea` (görsel yazısız kalır; yazının geleceği alan sakin bırakılır).
3. **Kayıt:** kullanılan layout `generationMetadata.layoutTemplate = {id, name}` ve `ExecutionJob.rawResult` içine yazılır.

## 4. Hangi yol layout'u nasıl seçer

| Yol                           | Layout                                                                                                                                                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sohbet `generate_image`       | Model `get_visual_identity` çıktısındaki `layouts` (id, ad, formatlar, başlık var mı) arasından seçer ve `layoutId` verir; belirsizse tek `ask_user` turunda seçenek olarak sorabilir. Yanıt kullanılan layout'un adını söyler. Bilinmeyen id varsayılana düşer ve model bunu söyler. |
| İçerik paketi                 | Parça başına ayrı seçim yok; format için marka varsayılanı.                                                                                                                                                                                                                           |
| Kart/Studio **revize** (edit) | Mevcut görselin layout'u aynen korunur: görüntüde logo/band zaten pikselde olduğundan başka layout ikinci bir logo/band bindirirdi. Layout'tan önce üretilmiş görsel eski gibi kompozit edilir.                                                                                       |
| Studio **sıfırdan üret**      | Studio'daki "Post layout" seçici; boşsa önceki layout (format şekli değişmediyse), değiştiyse yeni formata uygun olan.                                                                                                                                                                |
| Haftalık planlayıcı (cron)    | Marka kimliğiyle kurulan prompt + varsayılan layout + logo/şerit. Daha önce bu yol hiç şablon uygulamıyordu.                                                                                                                                                                          |

## 4b. Post style kit (örnek postlar)

Layout'lar logo/şerit/başlık yerleşimini belirler; **post tasarımının kendisi** (ürün odaklı düzen, tipografi, grafik öğeler) ise örnek post görselleriyle öğretilir. Bu, ayrı bir özelliktir: bkz. [post-style-kit.md](./post-style-kit.md). Örnekler Visual Identity sekmesindeki "Post style" kartından, sohbetten (`save_style_reference`) ya da beğenilen bir posttan eklenir ve her üretime referans resim olarak girer.

## 5. Geriye dönük uyum

- `layoutTemplates` boşsa (kaydedilmemişse) her şey eskisi gibi: markanın tek şablonu (logo köşesi + şerit), `safeZone` ve logo kırpma **yok**.
- Marka şablonu kapatmışsa (`templateEnabled = false`), layout kaydedilmiş olsa da kompozit yapılmaz.
- Layout galerisi "önerilen" layout'ları gösterir; **Save** edilmeden üretim eski şablonu kullanır.

## 6. Kurulum / migration

Yeni şema: `prisma/migrations/20260930100000_add_brand_layout_templates/` (`BrandVisualIdentity.layoutTemplates Json?`, nullable, eklemeli). İçerik planlama işinin `20260930000000_add_creative_plan_fields` migration'ı da bekliyor. Kodu paylaşılan DB'ye karşı çalıştırmadan **önce**:

```bash
npx prisma migrate deploy   # bekleyen migration'ları uygular
npx prisma generate
```

Sütun yoksa `BrandVisualIdentity` okuyan her sorgu (marka stili, sohbet görsel üretimi) hata verir. Yeni env değişkeni yoktur; tarama ve analiz mevcut `OPENAI_API_KEY`'i kullanır.

## 7. Elle doğrulama

1. Brand sekmesi → **Scan site** → `webhealth.com.tr`: bulunan logo/renk/font doğru mu, logo doğru yuvaya (açık/koyu) düştü mü, Apply sonrası sekme dolu mu.
2. Güvenlik: `http://127.0.0.1`, `http://169.254.169.254` ve özel IP'ye yönlendiren bir adres reddedilmeli.
3. Layout galerisi: Edit layouts ile bir layout'u değiştirip kaydet; önizlemede logo/şerit konumu.
4. Sohbet: "Bir post üret" → format sor → görsel; logo/şerit layout'taki yerde, yanıt layout adını söylüyor. Bir de "başlıklı, bant layout'u ile" dene.
5. Kartta **revize** → logo/band ikilenmemeli. Creative sayfasında Studio'da layout seçip "Regenerate from scratch".

## 8. Bilinen sınırlar

- Görsel üzerindeki yazı (5 Ekim 2026'dan beri) **modele çizdirilmez**: layout'un başlık bölgesi varsa (ya da Post Style Kit `match` ise) metin adımı kısa bir başlık (en çok ~6 kelime, isteğe bağlı vurgu ve bir alt satır) yazar; `creative-text.ts` bunu SVG yollarıyla (gömülü Inter; markanın ilk fontu Google Fonts'ta varsa o) bölgeye dizer: sarma, sığdırma, kontrast rengi, gerektiğinde yumuşak perde. Türkçe/Kiril harfleri doğru çıkar. Postun diğer biçimleri (Story, Facebook) yazısız temiz kopyadan uyarlanır ve aynı yazı o biçimin kendi bölgesine yeniden dizilir. Studio'da baştan üretme ("Regenerate") yazıyı korur; düzenleme ("edit") yazısı zaten pikselde olan resmi düzeltir. Bölgesi olmayan layout'lar (Classic, Image only) bilerek yazısızdır.
- Logo tonu (açık/koyu) piksel analiziyle bulunur; yanlışsa Brand Brain'den doğru yuvaya yükleyin.
- Layout önizlemesi CSS ile yaklaşıktır; logo kenar boşluğu kırpma önizlemede yansımaz.
- Studio'nun layout seçicisi yalnızca creative detay sayfasında görünür; takvim sayfasındaki gömülü Studio seçici göstermez (layout yine korunur).
- Tarama hız sınırı süreç içidir; birden çok instance'ta paylaşılmaz.

## Test

`safe-fetch.test.ts`, `site-scan/*.test.ts`, `brand-scan-actions.test.ts`, `layout-templates.test.ts`, `brand-kit.test.ts`, `layout-preview.test.ts`, `brand-summary-panel.test.ts`, `creative-template.test.ts`, `creative-layout.test.ts`, `logo-trim.test.ts`, `openai-creative.provider.inline.test.ts`, `tools.layouts.test.ts`, `creative-actions.layout.test.ts`, `creative-image-studio.test.ts`, `instagram-week-planner.test.ts` (DB'siz, sahte servislerle). Canlı OpenAI/tarayıcı ile uçtan uca test elle yapılır.
