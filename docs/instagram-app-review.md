# Instagram: herkesin hesabını bağlayabilmek için (App Review)

Şu an yalnızca Meta uygulamasında rolü olan (Instagram Tester) hesaplar bağlanabiliyor. Müşterilerin hesaplarını tester eklemeden bağlamak için uygulamanın **Advanced Access** alması gerekir. Bunun için Meta'ya başvuru (App Review) yapılır. Bu belge, başvurudan önce hazır olması gerekenleri ve kodda neyin hazır olduğunu listeler. Genel kurulum: `docs/instagram-login.md`.

## Kodda hazır olanlar (deploy sonrası canlı)

| Meta'nın istediği | Adres | Ne yapar |
|---|---|---|
| Privacy Policy URL | `https://agentelse.ai/privacy` | "Instagram connection" bölümü eklendi (hangi izinler, neyi saklıyoruz, otomatik/zamanlı yayın, nasıl silinir, Facebook yolu ve Meta Ads) |
| Terms URL | `https://agentelse.ai/terms` | zaten vardı |
| **Deauthorize callback URL** | `https://agentelse.ai/api/integrations/meta/deauthorize` | Kişi uygulamayı Instagram'dan kaldırınca bağlantıyı iptal eder (`REVOKED`) |
| **Data deletion request URL** | `https://agentelse.ai/api/integrations/meta/data-deletion` | Veri silme talebinde bağlantı kaydını (token, hesap id, kullanıcı adı) siler, `{url, confirmation_code}` döner |
| Data deletion instructions / durum sayfası | `https://agentelse.ai/data-deletion` | Silme talimatı; `?code=` ile bir talebin durumunu gösterir |

İki callback oturumsuz çalışır, Meta'nın `signed_request` imzasını Instagram ya da Meta uygulama secret'ıyla doğrular (imza doğrulanmadan hiçbir şey çözülmez; en çok 4096 karakter, gövde en çok 16 KB), imzasız isteğe 400 döner. Kişiyi iki kimlikten biriyle eşler (hesap id ve app-scoped id); **bu id'ler yalnızca 920d357'den sonra bağlanan hesaplara kaydedilir**, daha önce bağlanan hesabı eşleştirmek için yeniden bağlamak gerekir. Her doğrulanmış istek sunucu loguna tek satır yazar (`[meta-deauthorize] verified request (id length N): M connection(s) revoked`, `[meta-data-deletion] ... erased`; kimliğin kendisi yazılmaz), reddedilen istek `rejected` uyarısı bırakır: **Meta gerçekte ne gönderiyor, eşleşiyor mu** buradan görülür (`railway logs`).

**Facebook Page yolu eşleşmez:** o yolda Facebook kullanıcı id'si saklamıyoruz, yani Facebook Login için gelen bir silme/yetki iptali isteği hiçbir bağlantıyla eşleşmez. Bu yüzden bu iki callback adresini **yalnızca Instagram business login ayarlarına** girin, Facebook Login ayarlarına girmeyin. Eşleşmeyen istekte sayfa "eşleştirilemedi, e-posta atın" der (yalan söylemez).

## Meta panelinde girilecekler (sizde)

1. **Instagram > API setup with Instagram login > "4. Set up Instagram business login" > Business login settings**
   - Deauthorize callback URL: `https://agentelse.ai/api/integrations/meta/deauthorize`
   - Data deletion request URL: `https://agentelse.ai/api/integrations/meta/data-deletion`
2. **App settings > Basic:** uygulama ikonu (1024x1024), Privacy Policy URL, Terms of Service URL, kategori, iş e-postası. **User data deletion** alanına callback değil **talimat adresini** girin: `https://agentelse.ai/data-deletion`. Bu alan uygulamanın tamamı için (Facebook Login dahil) geçerli, callback eşleşemeyeceği için talimat adresi her durumda doğru olandır.
3. **Business Verification:** uygulamanın bağlı olduğu işletme doğrulanmış olmalı (Meta Business Suite > Ayarlar > Güvenlik merkezi). Şu an uygulama "Web Health | Sağlık Turizmi Dijital Ajansı" işletmesine bağlı; ürünü sunan işletmenin bu olduğundan emin olun.

## Başvurudan önce (sizde)

- **Test çağrıları:** Meta > Test sayfasında `instagram_business_content_publish` için "0 of 1 API call required" yazıyor. Agentelse'ten Instagram'a **bir gerçek yayın** yapın, gönderiyi sonra silin. Canlıda `WORKS_UI=true`: proje zaten yeni bir sohbetle açılır (ya da sol menünün üstündeki **New Chat**); bir Instagram görseli isteyin, kartta **Approve**'a basın, kartın altındaki satırda ("On hold: no publish time is set.") **Post now**'a, çıkan onayda ("Post to Instagram now? It goes live right away.") tekrar **Post now**'a basın. Sayaçlar 24 saate kadar geç güncellenebilir. `instagram_business_basic` için bağlanma sırasındaki profil okuması sayılır. `instagram_business_manage_insights` için sağ paneldeki **Marka** sekmesinde "Bağlı hesaplar" kartının altındaki **Instagram** kartını açmak yeter: kart açılırken hesabın son 28 günlük erişim ve görüntülenme toplamlarını okur (bir kez açıp birkaç dakika bekleyin, tarayıcı yanıtı 2 dakika saklar). **Önemli:** bu izin kodda sonradan eklendi, yani izin eklenmeden önce bağlanan bir hesabın token'ında yok. Kart o zaman profili ve gönderileri gösterir ama "Erişim ve görüntülenme için ek izin gerekiyor" der: **Connectors > Instagram > Disconnect**, sonra yeniden **Connect with Instagram** ile bağlayın ve Instagram onay ekranında yeni izni de verin.
- **Test projesinde otomatik yayını kapatın:** **Settings > Autonomy**'de **Review everything**'i seçin (varsayılan mod AUTOPILOT: bu modda sistem içeriği kendisi onaylar), sonra **Settings > Publishing**'de **Enable scheduled publishing** ve haftalık otomatik içerik planlamasını kapatın. Aksi halde proje, gözden geçiren hiçbir şeye basmadan yayın yapabilir (otomatik planlama ve yayın slotu açıksa gönderi insan tıklaması olmadan çıkar). Planlanmış saati olan bir parçada kartın altında "Post now" düğmesi de çıkmaz ("On hold" olan parçada çıkar): gözden geçirenin 5. adımı için yeni, zamansız bir Work kullanın. Bu hem başvuru metninin doğruluğu hem de beklenmedik gönderi için önemli.
- **Yalnızca üç izin isteyin:** `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`. `manage_comments`, `manage_messages` kullanılmıyor. **Instagram Public Content Access başvuruya EKLENMEZ:** o özellik hashtag aramasıdır (`ig_hashtag_search`), kodda hiçbir yerde kullanılmıyor; kullanılmayan bir özellik istemek ret sebebi olur. Bağlı hesabın kendi verisi (profil, gönderi sayaçları, insights) bu üç iznin kapsamında.
- **Gözden geçiren hesabı:** canlıda giriş yapılabilen bir test hesabı (e-posta/şifre) ve içinde bir proje. Instagram tarafında bağlanacak bir profesyonel hesap, **Meta uygulamasında Instagram Tester olarak Active** (gözden geçirenin Instagram hesabı da eklenebilir ya da sizin test hesabınız verilebilir).

## Başvuruya yapıştırılacak metinler (İngilizce)

**Permission: instagram_business_basic**
> Agentelse is a marketing workspace for agencies and brands. After a user signs in to Agentelse and chooses Connect with Instagram, we use instagram_business_basic to read the connected account's own id, username, account type, profile picture, follower, following and post counts, and its latest posts with their like and comment counts. The workspace shows them to the account's owner in an Instagram card in the project's Brand panel, so the owner can see which account is connected and how it looks. We read only the connected account's own data, only while the owner has the workspace open, and we do not store the counts. We do not read messages, the content of comments, follower lists or any other person's data.

**Permission: instagram_business_manage_insights**
> In the same Instagram card, Agentelse shows the owner how the connected account performed over the last 28 days: accounts reached, views, accounts that engaged and total interactions. We request these four account totals with instagram_business_manage_insights, only for the connected account and only while the owner has the workspace open. The numbers are shown on screen and are not stored. They help agencies and brands judge whether the content they create and publish with Agentelse is working. We do not read audience demographics or insights of any other account.

**Permission: instagram_business_content_publish**
> Agentelse helps agencies and brands create social posts and stories. The user creates or reviews a post in Agentelse and approves it. An approved post is published to the connected Instagram professional account with instagram_business_content_publish, either right away when the user presses Post now and confirms, or at the time the user set when they turned on scheduled posting (or Autopilot) for that project. Posts are published as feed posts or stories. Only approved content is published, and the user can turn scheduled posting and Autopilot off at any time (Settings).

**Reviewer instructions**
> 1. Open https://agentelse.ai/login and sign in with the test account given in the credentials field.
> 2. Open the project "<PROJE ADI: Meta'ya verilecek test projesinin adı>", then Connectors (left menu, under Channels) > Instagram.
> 3. Click "Connect with Instagram", sign in on Instagram with the test Instagram account (an Instagram Tester of this app) and tap Allow.
> 4. The connection dialog now shows the connected @username and account type.
> 4b. Close the dialog and open the project's workspace. In the right panel, open the "Brand" tab. Under "Bağlı hesaplar" (Connected accounts) the "Instagram" card shows the connected account's profile figures, the last 28 days (accounts reached, views, engaged accounts, total interactions) and the latest posts.
> 5. Open a new chat (the project opens on one; or click "New Chat" at the top of the left menu) and ask for "an Instagram post about <topic>". When the creative card appears, click "Approve". Under the card, click "Post now" and confirm with "Post now" again. The image is published to the connected account (visible on the account's Instagram profile).
> 6. To remove the connection: Connectors > Instagram > Disconnect, or remove Agentelse in Instagram > Settings > Apps and websites. Data deletion: https://agentelse.ai/data-deletion

## Ekran videosu senaryosu (İngilizce arayüz, ekranda kısa altyazılar)

Her izin için ayrı video, ya da tek videoda iki bölüm. 1-2 dakika.

1. **instagram_business_basic:** (altyazı: "Sign in to Agentelse") giriş > Connectors (sol menü, Channels altında) > Instagram > "Connect with Instagram" > Instagram onay ekranı, izin listesi görünsün, **Allow** > dönüşte pencerede "Instagram account: @username (Business)" satırı (altyazı: "Agentelse reads the account id, username and type to show which account is connected").
2. **instagram_business_manage_insights:** (altyazı: "Show the account's own results") bağlandıktan sonra projenin çalışma alanı > sağ panel > **Brand** sekmesi > "Bağlı hesaplar" kartının altındaki **Instagram** kartı: takipçi/takip/gönderi sayıları, "Son 28 gün" bloğunda erişilen hesap, görüntülenme, etkileşime giren hesap, toplam etkileşim, altında son gönderiler (altyazı: "Agentelse shows the connected account's own profile figures and 28-day totals to its owner"). `instagram_business_basic` videosunda da bu kartın profil kısmını gösterin.
3. **instagram_business_content_publish:** (altyazı: "Publish an approved creative") Sol menünün üstündeki **New Chat** > "an Instagram post about ..." > kartta **Approve** > altındaki satırda **Post now** > onayda **Post now** > "Sent to Instagram. It goes live in a moment." > Instagram uygulaması/web'de profilde gönderinin göründüğü an (altyazı: "The post appears on the connected Instagram account").
4. **Kaldırma:** Connectors > Instagram > **Disconnect**; sonra `https://agentelse.ai/data-deletion` sayfasını göster (altyazı: "Users can disconnect and request deletion at any time").

## Sonra

Onaylanınca kodda değişiklik gerekmez: müşteriler yalnızca profesyonel (Business ya da Creator) Instagram hesabıyla, tester eklemeden bağlanır. Meta, uygulamanın Data Use Checkup'ını yılda bir ister.
