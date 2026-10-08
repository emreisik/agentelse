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

## 2. Marka kiti nerede düzenlenir

Marka kimliğine ait tüm düzenleme **yalnız Brand Brain'dedir**; sağ panelin Brand sekmesi artık marka profili, kit veya strateji göstermez (yalnız bağlı hesaplar ve Instagram / Ads / Website / Search kartları).

`src/server/brand/load-brand-kit.ts` markanın görünüşünü `buildBrandKit` (`src/lib/brand-kit.ts`) ile tek bir `BrandKit` nesnesine çevirir; Assets ve Visual Identity sekmeleri aynı okumayı kullanır, böylece bir renk iki yerde farklı görünmez (Visual Identity renkleri varsa onlar, yoksa dossier'in onaylı renkleri).

- **Assets** (`brand-brain/assets-section.tsx`): logo (açık/koyu), renk ve font özeti (salt okunur, "Edit in Visual Identity" bağlantısı), konumlandırma, ses tonu, kitle/pazar/ürün/hizmet, kural sayaçları, "Brand basics" kontrol listesi, **Edit details**.
- **Visual Identity** (`brand/brand-kit-section.tsx` + `visual-identity-section.tsx` + `post-style-section.tsx`): **Scan site** şeridi, renkler ve stil (Visual Identity kartı), **Typography** (+ **Edit colors & fonts**, `brand-colors-fonts-edit.tsx`), **Post layouts** (+ **Edit layouts** / **Set up layouts**), post stili. Post şablonu kapalıysa layout kartı bunu söyler: layout'lar uygulanmaz.

## 2b. Visual Identity ayarları tasarıma nasıl yansır

Üç üretim yolu (ajans/sohbet işi `openai-creative.provider.ts`, Studio yeniden üret `creative-actions.ts`, haftalık planlayıcı `instagram-week-planner.ts`) aynı iki adımı kullanır. Sözleşme testi: `src/server/media/visual-identity-reach.test.ts`.

| Ayar | Nereye gider | Garanti |
|---|---|---|
| Ana / ikincil / vurgu renkleri | görsel istemi (BRAND); layout'un çubuk rengi; yazıda koyu mürekkep (ana) ve vurgulu kelime (vurgu) | istem: model yaklaşık uyar; çubuk ve yazı: piksel kesin |
| Fotoğraf stili, ince ayar, ruh hali | istem (STYLE & LIGHTING) | model yaklaşık uyar |
| Kompozisyon notları | istem (COMPOSITION) | model yaklaşık uyar |
| Arka plan tonu, hep ekle | istem (BRAND) | model yaklaşık uyar |
| Hiç yapma | istem (AVOID) | model yaklaşık uyar |
| Stil referansı görseli | modele referans görsel olarak eklenir | model yaklaşık uyar |
| Logo (açık/koyu) | `applyBrandTemplate` ile sonradan yapıştırılır, arka plan parlaklığına göre varyant seçilir | piksel kesin |
| Şablon açık/kapalı | kapalıysa logo, çubuk ve layout hiç uygulanmaz | kesin |
| Logo konumu/boyutu, çubuk | **Kayıtlı layout YOKSA ve şablon varsayılandaysa otomatik tasarım** (aşağıda, §2c). Marka şablonu elle özelleştirdiyse o aynen uygulanır; kayıtlı layout varsa layout karar verir (şablon alanları yok sayılır, yalnız açık/kapalı geçerli) | piksel kesin |
| Çubuk rengi | şablondaki renk, yoksa vurgu → ana → ikincil renk, en son eski dossier rengi (`lib/bar-color-candidates.ts`) | piksel kesin |
| Yazı tipi (Typography) | post sözleri için ilk onaylı font Google Fonts'tan yüklenir; yoksa Inter | piksel kesin; Google'da olmayan font Inter'e düşer |

Bağlam bir işin başında dondurulur (`ExecutionContextSnapshot`): bir ayarı değiştirmek, zaten kuyruktaki işi değil sonraki işleri etkiler. Reklam yeteneği (`CREATE_AD_CREATIVE`) de artık yazı tipini okur.

## 2c. Otomatik tasarım (ayar gerektirmez)

Hiçbir layout kaydedilmemişse ve marka şablonunu özelleştirmemişse her post, markadan ve formattan **türetilen** bir layout alır (`src/lib/auto-layout.ts` `autoLayout`; çıktı sıradan bir `LayoutTemplate`, yani `layoutToTemplateConfig`, `applyBrandTemplate` ve dizgici aynen çalışır). Seçim noktası `planCreativeLayout` (`creative-layout.ts`): sağlayıcı, Studio ve haftalık planlayıcı hepsi buradan geçer.

- **Arketip** (5): `editorial` (varsayılan), `product`, `promo`, `minimal-luxe`, `info`. Markanın kendi metninden (özet, konumlandırma, ürünler, constitution) anahtar kelimelerle ve ruh hali etiketleriyle belirlenir (`classifyArchetype`, `archetypeOfBrandContext`; DB'den okuyan `server/brand/design-archetype.ts`). Eşleşme yoksa `editorial`. Tek ayar: Brand Brain → Visual Identity → Post layouts kartındaki **Look** seçici (Automatic + 5 görünüm). Seçim `BrandVisualIdentity.designProfile` (`{archetype, source:"user"}`, `src/lib/design-profile.ts`, migration `20261007100000_add_brand_design_profile`) alanında saklanır ve sözcüklerden çıkan tahmini geçersiz kılar; Automatic'e dönmek alanı temizler (`updateDesignLookAction`).
- **Format başına ayrı tasarım:** feed, kare, yatay, Story. Story'de kenar şeridi yok, logo uygulamanın kontrol alanının üstünde. Kenar boşluğu her formatta kısa kenarın %4'ü.
- **Logo boyutu şekle göre** (`src/lib/logo-fit.ts`): `sizePercent` bir "varlık düzeyi" olarak okunur, logonun kendi en-boy oranına sığdırılır; genişlik en çok yüzde 32, yükseklik en çok kısa kenarın yüzde 12'si, okunur taban. Geniş wordmark biraz daha geniş, kare amblem biraz daha küçük çizilir. Kayıtlı layout'lar da bundan yararlanır (`logoFit: "shape"`).
- **Logo temizliği** (`server/media/logo-clean.ts`): düz beyaz arka plan şeffaflaştırılır (JPEG dahil), boş kenar kırpılır. Elle yüklenen ve AI ile üretilen logolar kayıtta bu hâle getirilir ve gerçek boyutu saklanır.
- **Okunurluk:** logonun arkasındaki bölge ile logo arasındaki kontrast düşükse (tek varyant, aynı renkte bant) tek renkli logo beyaz/siyaha boyanır, çok renkliye yumuşak plaka konur.
- **Yazı:** otomatik tasarımda `minimal-luxe` dışındakilerde başlık bölgesi vardır; yani layout'u olmayan markalar da artık görsel üzerinde başlık alır.

### Post designs (çizgisiz, gerçek önizlemeli)

Otomatik tasarım artık **6 profesyonel tasarım**dır ve hiçbirinde şerit, bant ya da çizgi yoktur: görsel, bir başlık ve logo. `Archetype` adları saklanan değerlerdir, görünen adlar `ARCHETYPE_LABEL`'dadır: `editorial` Editorial (üstte başlık, köşede logo), `statement` Statement (ortada dev tek satır, üstte logo), `product` Bottom headline (altta başlık, üst köşede logo), `promo` Poster (sol üstte XL başlık, sağ altta logo), `info` Column (solda metin sütunu), `minimal-luxe` Minimal (başlıksız, ortada küçük logo). Kitin "match" örneklerinden gelen şerit bilgisi (`traits.bar`) artık yok sayılır.

Seçim Brand Brain → Visual Identity → **Post designs** galerisindedir (`design-gallery.tsx`): format sekmesi (Feed/Square/Landscape/Story), "Preview on" ile markanın kendi temiz fotoğrafı (kütüphane yüklemeleri, `type IMAGE`, `CUSTOMER_UPLOAD`) ya da yerleşik 3 sahne, her kart **gerçek üretim koduyla** çizilir. Önizleme `GET /api/projects/:id/design-preview?design&format&photo` (`server/brand/design-preview.ts`): `composeBrandTemplate` (`applyBrandTemplate`'in depolamadan bağımsız çekirdeği) markanın logosu, fontu, renkleri, güvenli alanı ve örnek yazıyla (markanın dilinde) çalışır; yani önizleme ile post birebir aynı kodtur. Seçim **format başınadır**: Feed, Square, Landscape ve Story'nin her biri kendi tasarımını alır (`BrandVisualIdentity.designProfile = {formats: {feed?, square?, landscape?, story?}, source:"user"}`, `lib/design-profile.ts`; ilk sürümdeki tek `archetype` alanı okunurken tüm formatlara açılır). Seçilmeyen format markanın sözcüklerinden çıkan otomatik tasarımı izler. Galeride sekme = format; "Use X for all formats", "Feed back to automatic" ve "All back to automatic" düğmeleri vardır (`updateDesignLookAction(projectId, format|"all", design|null)`). Çözüm sırası `planCreativeLayout`'ta: revizyonun kendi tasarımı → o formatın seçimi → markanın otomatik tasarımı. Seçim tüm yerlerde geçerlidir (sohbet, plan, fikir, haftalık plan, Studio). Marka kendi özel layout'larını kaydetmişse galeri yerine bir bildirim ve "Use the post designs instead" düğmesi çıkar (`clearLayoutTemplatesAction`). Tarama diyaloğunun layout adımı kaldırıldı: tarama artık layout kaydetmez, tasarımlar otomatik kalır. Eski layout düzenleyici ve galerisi kodda duruyor ama hiçbir ekrandan açılmıyor.

### Görsel yönetmen (resim istemi mühendisliği)

Görsel model artık fikrin "ortalama resmini" değil, markanın içinden çıkan bir çekim listesini alır. `server/media/art-director.ts` (`directImage`), fikir/brief + marka bağlamından (ne satıyor, kime, hangi ülke/kültür, constitution özeti, farklılaştırıcılar, kitle, ürünler, fotoğraf stili, ruh hali, always-include/avoid, "işe yarayanlar", "asla göster", son onaylı sahnelerin istemleri) ayrı bir model çağrısıyla `ArtDirection` üretir (`lib/art-direction.ts`): `concept` (görsel fikir), `subject`, `setting`, `composition`, `lighting`, `technique` (objektif/diyafram veya illüstrasyon yöntemi), `texture`, `mood`, bu resme özel `avoid` listesi ve çok resimli işlerde tam `alternatives` sahneleri. `assembleScene` bunları SUBJECT olarak birleştirir; `avoid` kaynağı `creative-prompt-builder` AVOID bölümüne "For this picture:" olarak eklenir.

Kurallar: taslak istem (metin adımı veya sohbet) ve brief'in açıkça istediği her şey korunur, yönetmen yalnız zanaat ve özgüllük ekler; marka renkleri sahnede doğal biçimde (yüzey, aksesuar, ışık) görünür, düz renk filtresi olarak değil; başlığın dizileceği bölge ve logo köşeleri boş bırakılır; resimde yazı/logo yok; post stili örnekleri "match" ise tasarıma karışmaz; gerçek ürün fotoğrafı varsa o ürün birebir gösterilir. Yazı yazarıyla (copywriter) eşzamanlı çalışır, ek gecikme yaratmaz. Hata olursa eski istem aynen kalır. Üç yolda da bağlı: sağlayıcı (sohbet, plan, fikir), haftalık planlayıcı (artık metin adımı olmadan doğrudan fikirden üretiyordu) ve Studio yeniden üretimi (düzenleme modu hariç). Kayıt: `rawResult.artConcept` / `generationMetadata.artConcept`.

### Performans (Post designs galerisi)

Önizleme istekleri artık: marka bağlamı (stil, font, dil, iki logo) 30 sn boyunca tek okunur ve altı kart paylaşır; temizlenmiş logo bayt içeriğine göre önbelleklenir (üretim hattı da yararlanır: `cleanLogo`); sahne/fotoğraf boyutuna göre bir kez çizilir; en çok 2 render aynı anda koşar (kalanı sırada), böylece galeri uygulamayı dondurmaz; Google font ilk render'da iki ağırlık birlikte indirilir ve geçici bir ağ hatası kalıcı Inter'e yol açmaz (60 sn sonra yeniden denenir); her resmin adresine görünüm anahtarı (`v`) girer ve anahtar hâlâ geçerliyse `immutable` önbelleklenir: tarayıcı bir görünüm için her resmi bir kez ister.

### Yazı tipi

Yazı tipi seçici (`font-picker.tsx`): ~30 sosyal medyaya uygun Google Fonts, 5 ruh halinde (`lib/google-fonts.ts`), kendi harfleriyle ve Türkçe örnekle gösterilir; listede olmayan herhangi bir Google Font adıyla da eklenebilir (var olduğu doğrulanır). Seçim `approvedFonts[0]` olur ve postlardaki yazı bununla dizilir. Taramadan gelen next/font adları (`__Montserrat_0e8a88`, `..._Fallback_...`) `lib/font-names.ts` ile gerçek aileye çevrilir/atılır, hem taramada hem okurken.

### Vurucu yazı (copywriter adımı)

Görsel üzerindeki yazı artık ana çağrının son alanı değil. `headline-budget.ts` yerleşimin kapasitesinden bir bütçe çıkarır (örn. feed/TOP/L/3 satır: 4-8 kelime, ≤ ~50 karakter; "en fazla 6 kelime" kalktı). `headline-copywriter.ts` markanın sesi, kitlesi, onaylı iddiaları, "asla" kuralları, öğrenmeleri ve son başlıkları ile ayrı bir model çağrısı yapar (`{headline, highlight, subline, cta}`), çıktıyı temizler (tırnak/hashtag/emoji/nokta) ve bütçeyi doğrular. Sağlayıcıda yalnız modelin kendi yazdığı taslağa uygulanır; sohbette müşterinin dikte ettiği ve uyarlanan postun yazısına dokunulmaz. Hata olursa taslak kalır. Fikir motoru başlığı artık taslaktır (en çok 9 kelime).

### Eylem satırı, planlayıcı ve örneklerden yerleşim

- **Eylem çağrısı (CTA):** `OnImageText.cta` yazıya ayrı bir alan; dizgici (`creative-text.ts`) onu başlık/alt satırın altında, vurgu renginde (yoksa mürekkep renginde) bir hap olarak çizer, etiketi beyaz/near-black'ten okunur olanı alır. Yazar adımı `cta`'yı (en çok 24 karakter) `subline`'dan ayrı üretir.
- **Haftalık planlayıcı** (`instagram-week-planner.ts`): layout'unda başlık bölgesi varsa her post için yazar adımı çalışır; görsel yazısız üretilir, sözler sonradan basılır ve `generationMetadata.onImageText` olarak kaydedilir. Yazar başarısız olursa post eskisi gibi temiz görsel olur.
- **Örnek postlardan yerleşim** (`PostStyleAnalysisSchema.traits`): örnek analizi artık logo köşesi, başlık bölgesi/hizası/ölçeği ve şerit tipini yapısal olarak da çıkarır. Kit "match" iken örneklerin çoğunluğu (`postStyleTraitsOf`) otomatik tasarımı yönlendirir; "inspired"da yalnız görsel modele yön olarak gider. Story kendi güvenli alan tasarımında kalır. Eski analizlerde `traits` yoktur: örnek yeniden analiz edilince devreye girer.

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

1. Brand Brain → Visual Identity → **Scan site** → `webhealth.com.tr`: bulunan logo/renk/font doğru mu, logo doğru yuvaya (açık/koyu) düştü mü, Apply sonrası sekme dolu mu.
2. Güvenlik: `http://127.0.0.1`, `http://169.254.169.254` ve özel IP'ye yönlendiren bir adres reddedilmeli.
3. Brand Brain → Visual Identity → Post layouts: Edit layouts ile bir layout'u değiştirip kaydet; önizlemede logo/şerit konumu.
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
