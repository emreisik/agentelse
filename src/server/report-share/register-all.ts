import "server-only";

// Her çizici modülü yan etkiyle kaydolur; /r/[token] sayfası bu dosyayı içe
// aktarır. Yeni bir tür eklenince çizici modülü buraya eklenir.
import "./search-renderer";
// GA-F8: 'WEBSITE' çizicisi kendi paketinde durur; bu içe aktarma olmadan bir
// WEBSITE paylaşımı nötr 404 verir.
import "@/server/website-analytics/agency/share-renderer";
