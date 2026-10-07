# WordPress entegrasyonu (SC-F8, SK11 a)

Plan: [google-search-console-plan.md](google-search-console-plan.md) §3.9, §9 SC-F8. Uygulama katmanı (motor, onay, geri alma, IndexNow): [website-apply.md](website-apply.md). AI arama görünürlüğü: [ai-search-visibility.md](ai-search-visibility.md). Bu dosya yalnız WordPress bağlayıcısının planını ve uygulanmış hâlini anlatır; Shopify ve Webflow ayrı planlardır.

## Durum (7 Ekim 2026)

Kodlandı, bayrakla kapalı (`SEO_APPLY`), canlıda denenmedi. Migration: `20261006221000_add_seo_apply` (`CmsSite`, `SeoChange`, `SeoApplySetting`, `SeoGeoAudit`). WordPress, Yoast ve Rank Math REST şekilleri herkese açık belgelerden ve hafızadan yazıldı, gerçek bir siteye karşı doğrulanmadı; her biri kodda "(doğrulanmalı)" ile işaretli ve aşağıdaki "Doğrulanmalı" listesinde toplu.

| Parça                                                                  | Durum                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| Bağlanma, Test, Re-check the site, Disconnect (Connectors > WordPress) | Yapıldı (tarayıcıda görülmedi)                 |
| Taslak makale (`PUBLISH_ARTICLE`), yayına alma (`PUBLISH_LIVE`)        | Yapıldı                                        |
| Başlık ve meta (`TITLE_META`), iç bağlantılar (`INTERNAL_LINKS`)       | Yapıldı                                        |
| Onay, geri alma, hız sınırı, tekrar deneme ve devam                    | Yapıldı ([website-apply.md](website-apply.md)) |
| Mock WordPress sitesi (ağ yok)                                         | Yapıldı                                        |
| Gerçek WordPress, Yoast ve Rank Math ile deneme                        | Yapılmadı (aşağıdaki liste)                    |

## Amaç ve ilkeler

1. Onaysız yazma yok: sitede her yazma, bir workspace OWNER/ADMIN'inin onayladığı bir `Approval` ister. Taslak oluşturmak da yazmadır.
2. Taslak varsayılan: makale hiçbir zaman doğrudan yayına gitmez. Yayına almak ayrı bir değişiklik ve ayrı bir onaydır.
3. Silme yok: tek kaldırma, Agentelse'in kendi oluşturduğu taslağı geri alırken WordPress Çöp Kutusu'na taşımaktır (kurtarılabilir). `force` silme hiçbir yerde yoktur.
4. Geri alınabilir: onaylanıp yazılan her değişiklik 90 gün boyunca geri alınabilir (zaten sağlanmış, yani hiçbir şey yazmamış `noop` değişiklik hariç).
5. Search Console salt okunur kalır (SK10). SC-F8 Search Console'a hiçbir şey yazmaz; `read-only.test.ts` bunu pinler.

## Bağlanma

Kullanıcı site adresini, bir WordPress kullanıcı adını ve bir Application Password'ü girer (WordPress > Users > Profile > Application Passwords). Parola boşluklarıyla verilebilir; boşluklar atılır, 24 karakter olmalıdır.

- https zorunlu. Yalnız kök dizin kurulumu desteklenir: alt klasör (`https://example.com/blog`) `subfolder`, `*.wordpress.com` siteleri `wordpress_com` ile reddedilir.
- Ayrı bir Editor kullanıcısı önerilir ("Use a dedicated WordPress user with the Editor role."). Kullanıcı `administrator` ise uyarı gösterilir: "This account is an administrator. An Application Password can do everything its user can. Create an Editor user for Agentelse instead."
- Güvenlik duvarı: tüm istekler sabit, tanımlayıcı bir User-Agent ile gider: `AgentelseSEO/1.0 (+https://agentelse.com)`. Bir WAF engellerse `rest_blocked` görünür ve bu ajanı izin listesine almak önerilir.
- Kimlik bilgisi `IntegrationCredential` içinde şifreli durur: key-ring (`encryptToken`), anahtar kimliği `metadata.keyId` (`legacy` = `TEMPORARY_SECRET_ENCRYPTION_KEY`). Parola hiçbir görünümde, logda ya da hata metninde yoktur. `metadata` yalnız `{keyId, origin, administrator}` taşır.
- Mock kipte sağlayıcı `wordpress_mock`, gerçek kipte `wordpress` olur. Tablo `(projectId, provider)` üzerinde tekil olduğundan mock bir süreç gerçek parolayı asla okuyamaz, ezemez ya da silemez. `CmsSite.isMock` kayıtlı kipi taşır; Connect, Test ve Disconnect yalnız süreç kipiyle aynı `isMock` satırına dokunur.
- Alan adı bağı: bağlanmak için Search sayfasında doğrulanmış bir `SeoSite` kapsamı gerekir (`no_verified_site`). Kapsam anahtarı `SeoSites.readState(projectId).scope?.key` olarak `CmsSite.scopeKey`'e yazılır. Her öneride ve her yazmada kapsamın var olduğu, adresin `inScope` olduğu ve anahtarın değişmediği yeniden denetlenir (`domain_mismatch`, `scope_changed`). Tam yeniden bağlanma olmadan kurtarma: Test > "Re-check the site" (yalnız OWNER/ADMIN; adresi geçerli kapsama karşı yeniden doğrular ve anahtarı yeniler).
- Farklı bir adrese yeniden bağlanmak eski `CmsSite` satırını ve değişiklik kayıtlarını siler (eski `wpId` değerleri yeni sitede yanlış sayfaları gösterirdi). Aynı adrese yeniden bağlanmak (yeni parola) satırları korur.

## Yetenek denetimi

Bağlanırken ve Test'te `users/me` okunur; roller ve yetenekler `CmsSite.capabilities`'e yazılır: `edit_posts`, `publish_posts`, `edit_published_posts`, `edit_pages`, `edit_published_pages`, `edit_others_posts`, `delete_posts`.

| Sağlık                                   | Anlamı                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| OK                                       | Taslak, yayın ve yayındaki yazı/sayfa düzenleme yetenekleri var                                     |
| LIMITED                                  | Bağlı ve çalışıyor ama bazı yetenekler eksik (ör. Contributor: yalnız taslak). Eksik tür reddedilir |
| NO_PERMISSION                            | `edit_posts` bile yok (Subscriber)                                                                  |
| AUTH                                     | WordPress parolayı kabul etmiyor (`reconnect`)                                                      |
| UNREACHABLE, NOT_WORDPRESS, REST_BLOCKED | Adres, REST ya da WAF sorunu                                                                        |
| DOMAIN_MISMATCH                          | Adres artık doğrulanmış kapsamın dışında                                                            |

Her değişiklik türü için gereken yetenek: `PUBLISH_ARTICLE` taslak yazma; `PUBLISH_LIVE` yayınlama; `TITLE_META` ve `INTERNAL_LINKS` yayındaki yazıyı/sayfayı ve başkalarının içeriğini düzenleme.

## Neyi değiştirebiliriz

| Tür               | WordPress yolu                                          | Okuma geri                                                      | Geri alma                                                               | Onay satırları                                                         |
| ----------------- | ------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `PUBLISH_ARTICLE` | `POST wp/v2/posts` (`status: "draft"`, sabit kodlanmış) | Başlık, metin özeti, durum `draft`, SEO alanları (okunabilirse) | Taslağı Çöp Kutusu'na taşır (yalnız hâlâ taslaksa ve `modified` eşitse) | What happens, Where, Title, Length, Undo, Expires                      |
| `PUBLISH_LIVE`    | `POST wp/v2/posts/{id}` (`status: "publish"`)           | Durum `publish`                                                 | Yazıyı yeniden taslak yapar                                             | What happens, Where, Page, (taslak düzenlendiyse uyarı), Undo, Expires |
| `TITLE_META`      | `POST wp/v2/{posts\|pages}/{id}` + SEO eklentisi alanı  | Başlık ve eklenti alanları (okunabilen)                         | Önceki değerleri geri yazar                                             | Before/After (ya da Title/Description before/after), Undo, Expires     |
| `INTERNAL_LINKS`  | `POST wp/v2/{posts\|pages}/{id}` (`content`)            | İçerik özeti (`contentHash`)                                    | Önceki ham içeriği geri yazar                                           | Page, Link 1-3, Undo, Expires                                          |

Her satırda sayfa yolu yalnız onay satırlarında (`payload.details`) görünür; Task ve Approval başlıkları sabittir.

## Neyi asla yapmayız

Sayfa ya da yazı silmek, tema ya da eklenti değiştirmek, medya yüklemek, kategori/etiket/yazar atamak, özel yazı türleri, sayfa oluşturucu (Elementor, Divi, WPBakery, Fusion) sayfalarının içeriği, `robots.txt` ya da sitemap düzenlemek, şema (JSON-LD) enjekte etmek. Plan §3.9'daki "başlık, meta ve şema güncelleme" bu yüzden "başlık ve meta" olarak uygulandı; "sitemap dosyasını CMS üzerinden düzelt" ertelendi.

## SEO eklentisi alanları (doğrulanmalı)

Bağlanırken REST dizinindeki ad alanlarından eklenti bulunur (`yoast/v1`, `rankmath/v1`; ikisi de varsa Rank Math kazanır) ve örnek bir yazıda REST'e gerçekten açılan meta anahtarları yoklanır.

- Yoast (anahtarlar `meta` içinde görünüyorsa): `_yoast_wpseo_title` ve `_yoast_wpseo_metadesc` çekirdek `meta` özelliğiyle yazılır ve geri okunur. Boş SEO başlığı "varsayılan şablon" demektir; onay satırı "(default title)" der, şablon (`%%title%% %%sep%%`) ham hâliyle gösterilir. Geri almada boş önceki değer `""` yazılarak geri verilir.
- Rank Math: anahtarlar gizliyse `rankmath/v1/updateMeta` ucu kullanılır; okunamadığı için geri okuma kısmidir (SC-F6 tarayıcısı herkese açık sayfayı sonra doğrular). Yeni taslakta Rank Math ucu hiç kullanılmaz (yazı kimliği henüz yok); meta açıklama o durumda yalnız özet (`excerpt`) üzerinden gider.
- Yedek: eklenti yok ya da Yoast anahtarları gizliyse başlık çekirdek yazı başlığına yazılır (onay satırı: "This also changes the page heading on most themes."); meta açıklama değişikliği reddedilir (`seo_plugin_unsupported`).
- Çekirdek `excerpt` yalnız yeni taslakta ayarlanır.

## İç bağlantılar

Bir değişiklik tek sayfada en çok 3 bağlantı ekler; bağlantı metni 2-60 karakterdir.

- Blok içerik (`<!-- wp:` içerir): yalnız `wp:paragraph` / `<p>` içine. Klasik editör içeriği: boş satırla ayrılmış, blok düzeyi etiketle başlamayan parçalar paragraf sayılır ve bağlantı satır içi eklenir (`<p>` eklenmez; WordPress `wpautop` ile sarar).
- Asla `a`, `h1-h6`, `button`, `code`, `pre`, `script`, `style` içine ya da bir özniteliğe girmez. İlk büyük/küçük harfe duyarsız tam sözcük eşleşmesi kullanılır. Zaten hedefe giden bir bağlantı "sağlanmış" sayılır (tekrar çalıştırmak güvenlidir).
- Sayfa oluşturucu işaretleri ya da boş ham içerik: `builder_page` ile reddedilir ("This page is built with a page builder. Agentelse cannot safely edit its content.").
- Önceki anlık görüntü ham içeriği (en çok 200.000 karakter) saklar; geri alma onu geri yazar.
- Risk: `unfiltered_html` yetkisi olmayan kullanıcıda WordPress `kses` öznitelikleri silebilir; okuma geri `contentHash`'i karşılaştırır ve `readback_mismatch` verir (geri alınabilir), başarı raporlamaz.

## Taslak ve yayına alma

`PUBLISH_ARTICLE` her zaman `draft` gönderir; durum parametresi yoktur. Yayına almak `PUBLISH_LIVE`'dır: kendi onay kartı vardır ("Makes the draft visible to everyone on your site.") ve `expectModified` taşır: taslak onay istendikten sonra WordPress'te düzenlendiyse `page_changed` ile reddedilir. Taslak, Agentelse oluşturduktan sonra düzenlenmişse onaylayanın satırı "The draft was edited in WordPress after Agentelse created it." der. Zamanlama (`future`) yoktur; makaleyi Agentelse takviminde zamanlamak WordPress yazısını zamanlamaz (arayüz bunu söyler).

## Bayat sayfa koruması

Öneri anında canlı nesne okunur ve `modified_gmt` `expectModified` olarak saklanır. Uygulamada yeniden okunur; değişmişse `page_changed` ("The page was edited after you reviewed this. Nothing was changed. Propose it again."). Katı zaman eşitliği zararsız bir başka düzenlemeyi de reddedebilir; kullanıcı yeniden önerir.

## Idempotans, tekrar deneme ve devam

- İlk talepte önceki (before) anlık görüntü saklanır ve bir daha ezilmez. Sonraki her denemede `planChange` buna `prior` olarak bakar.
- Zaman aşımına uğrayan bir `POST` gerçekte işlemiş olabilir. Taslak oluşturma asla yeniden denenmez; bir sonraki deneme son taslakları arar (aynı başlık, aynı metin özeti, 30 dakika içinde değişmiş) ve eşleşeni benimser. Güncellemelerde canlı nesne yeniden okunur: hedefe zaten ulaşılmışsa ve `prior` bunu sağlamıyorsa yazma bizden gelmiştir; satır `noop=false` ile VERIFIED olur (sayılır, geri alınabilir, SC-F6 eylemine bağlanır). Yalnız gerçekten farklı bir canlı durum `page_changed` verir.
- Çok yazmalı değişiklik (TITLE_META: önce çekirdek güncelleme, sonra Rank Math ucu) yalnız ilk yazısı işlediyse APPLIED kalır ve devam eder; yalnız kalan yazı gönderilir. 3. denemede de olmazsa FAILED olur, `appliedAt` korunur ve yazılmış FAILED satırı arayüzden geri alınabilir.

## Hız sınırı

Varsayılan 10 uygulanan (noop olmayan) değişiklik / 24 saat kayan pencere / `CmsSite`. `SeoApplySetting.dailyLimit` 1-25 (OWNER/ADMIN, Connectors > WordPress). Sınıra gelmek onaylı değişikliği başarısız etmez: satır APPROVED kalır, `nextAttemptAt` en eski değişikliğin pencereden çıkacağı an olur ("Daily limit reached. It will go ahead automatically when there is room.").

## Geri alma

Açık bir OWNER/ADMIN tıklamasıdır (ikinci bir onay değil). VERIFIED ve yazılmış FAILED (`appliedAt` dolu) satırlar, `appliedAt`'ten 90 gün içinde, `noop=false` ise geri alınabilir. Koşullar: canlı `modified` saklı `after.modified`'a eşit olmalı (yazılmış FAILED satırında `after` bilinmiyorsa atlanır ve yalnız değişikliğin dokunduğu alanlar geri verilir); `PUBLISH_LIVE` için canlı durum hâlâ `publish`; `PUBLISH_ARTICLE` için taslak hâlâ taslak. Zincir: taslak oluştur > yayına al > yayını geri al > makaleyi geri al çalışır, çünkü `PUBLISH_LIVE` VERIFIED/UNDONE olunca taslak değişikliğinin `after` anlık görüntüsüne yeni `modified` ve durum yazılır. Yazı yayındayken makaleyi geri almak `cannot_undo`'dur ("It was changed again in WordPress since. Undo it there if you still want it reverted."). WordPress 404 derse yazı zaten gitmiştir ve geri alma UNDONE ile biter. SC-F6 ölçümü başladıktan sonra geri almak eylemi geri sarmaz.

## Hata katalogu

Her koddan kullanıcıya gösterilen metin sabittir (`SEO_CHANGE_ERROR_MESSAGES`); WordPress'ten gelen metin asla saklanmaz ya da gösterilmez. Kodlar: `not_enabled`, `not_connected`, `site_unhealthy`, `reconnect`, `no_permission`, `domain_mismatch`, `scope_changed`, `page_not_found`, `page_ambiguous`, `page_changed`, `builder_page`, `anchor_not_found`, `seo_plugin_unsupported`, `limit_reached`, `readback_mismatch`, `site_unavailable`, `rejected_by_site`, `rate_limited`, `cannot_undo`, `approval_missing`, `article_gone`, `unknown`. `domain_mismatch`, `scope_changed` ve `reconnect` ayrı, farklı metinlere sahiptir (adres artık doğrulanmış sitenin dışında / doğrulanmış site değişti, Test ile yeniden denetle / WordPress kayıtlı parolayı kabul etmedi, yeniden bağla). Bağlanma hataları için `CONNECT_ERROR_MESSAGES` (ör. `app_passwords_disabled`, `bad_credentials`, `not_https`, `subfolder`, `wordpress_com`, `rest_blocked`, `busy`).

## Mock site

`AGENTELSE_PROVIDER_MODE=mock`: `mock-site.ts` bellek içi, deterministik sahte bir WordPress sitesi verir (örnek yazılar, sayfalar, Yoast alanları, bir editör kullanıcı). Ağ çağrısı yok; sağlayıcı `wordpress_mock`, `CmsSite.isMock = true`. Mock kullanıcı adı olarak herhangi bir boş olmayan ad ve `bad` içermeyen herhangi bir parola kabul edilir.

## Disconnect

Connectors > WordPress > Disconnect: önce kayıtlı Application Password en iyi çabayla iptal edilir (introspect + DELETE), sonra kimlik satırı ve `CmsSite` (ve cascade ile tüm `SeoChange` satırları) silinir; bekleyen onaylar iptal edilir ve her değişikliğin Task ve sohbet kartı metinleri temizlenir (hem "approval-request" hem "approval-decision" kartı). Bir değişiklik APPLYING/UNDOING ve canlı kilitle sürerken Disconnect `busy` ile reddedilir. Değişikliklerin kendisi geri alınmaz; kullanıcı önce Undo kullanmalıdır. Proje silmek aynı verileri siler ama Application Password'ü iptal etmez; veri silme sayfası önce Disconnect'i ya da WordPress'te iptali söyler. SEO_APPLY kapalıyken bile Disconnect'in kendi temizliği bayraktan bağımsız çalışır; fakat kutucuk gizli olduğundan bağlantıyı kesmek için bayrağı o proje için önce açmak gerekir.

## Gizlilik

`SeoChange` önce/sonra/parametre alanları müşterinin kendi sayfa içeriğini (başlık, açıklama, bağlantı metni, iç bağlantı için ham içerik) taşır; 24 ay saklanır, `params.markdown` terminal durumdan 30 gün sonra, `before.contentRaw` 90 gün sonra boşaltılır. Onaylanan metin müşterinin kendi içeriğidir ve Search Console bağlantısı kesilince silinmez. `AuditLog` yalnız `{changeId, kind, source?, code?, dailyLimit?}` taşır. Telegram'a hiçbir şey gitmez. Operatör yalnız sayaçları görür. Ayrıntı: [website-apply.md](website-apply.md) "Gizlilik ve Limited Use" ve `/privacy#wordpress-and-website-changes`.

## Doğrulanmalı

Gerçek bir test WordPress'inde, `SEO_APPLY` müşteriler için açılmadan önce:

1. `rankmath/v1/updateMeta` gövdesi ve yanıtı.
2. Yoast meta anahtarlarının (`_yoast_wpseo_title`, `_yoast_wpseo_metadesc`) REST'e açık olup olmadığı; boş Yoast değerinin "varsayılan şablon" anlamına geldiği ve geri almada `""` yazmanın bunu geri verdiği.
3. `DELETE wp/v2/posts/{id}` (`force` olmadan) yazıyı Çöp Kutusu'na taşıyor mu.
4. `wp/v2/users/me/application-passwords/introspect` ve `DELETE` ile iptal.
5. `rest_route` kipi (güzel bağlantılar kapalıyken) ve yönlendirmeler.
6. `modified_gmt` alanının eşitlik karşılaştırması için yeterince kararlı olup olmadığı.
7. `kses` ile içerik yeniden serileştirmesi (özellikle iç bağlantılarda).
8. Klasik editör içeriğinde `wpautop` ile iç bağlantı ekleme.
9. Sayfa önbelleği / CDN gecikmesi (SC-F6 doğrulayıcısı günlük yeniden dener).
10. Blok serileştirme ayrıntıları (`wp-block-heading`, `wp-block-list`, `wp:list-item` iç blokları) ve yüzde kodlu slug araması.

## Sonraki CMS'ler

Shopify ve Webflow (plan SK11 b, c): ayrı plan ve ayrı bayrak. Bu bağlayıcının `CmsSite.kind` alanı ve motorun `WpWrite` soyutlaması bunun için hazırdır, ama başka CMS yazılmadı.
