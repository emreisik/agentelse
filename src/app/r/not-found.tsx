// /r altındaki her notFound() bu sayfayı çizer: bilinmeyen, süresi dolmuş,
// iptal edilmiş, silinmiş ya da bayrağı kapalı bağlantı AYNI nötr metni
// gösterir. Ürün adı ve bağlantı yok; neden ayırt edilemez.
export default function ReportLinkNotAvailable() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <p className="text-sm text-muted-foreground">
        This link isn&apos;t available.
      </p>
    </div>
  );
}
