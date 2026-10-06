import { AsyncLocalStorage } from "node:async_hooks";

import type { MetaCallFamily } from "./error-catalog";

// Bir Meta çağrısının bağlamı (docs/meta-ads-plan.md §3.1 Uyarlamalı kısma):
// hangi reklam hesabının kotasını harcadığı ve hangi öncelik şeridinde
// koştuğu. Çağıranlar fonksiyon imzalarını değiştirmeden bağlamı
// `withMetaCallContext` ile verir; graph çekirdeği okur.
//
//   P0_SAFETY      güvenlik eylemleri (pause, kill switch): hiçbir yerel
//                  kesiciye takılmaz, yalnız Meta'nın blok süresine uyar
//   P1_USER        kullanıcının beklediği iş (yazma ve okuma)
//   P2_BACKGROUND  arka plan senkronu: kota %75'i aşınca bekler
export type MetaLane = "P0_SAFETY" | "P1_USER" | "P2_BACKGROUND";

export type MetaCallContext = {
  lane?: MetaLane;
  // "act_<id>": nesne kimliğiyle yapılan çağrılarda (POST /{campaign_id})
  // hesap URL'de görünmez, bağlamdan gelir.
  account?: string;
  family?: MetaCallFamily;
  // Kota ölçümünde çağrı noktası etiketi (ör. "sync.structure").
  callSite?: string;
};

const storage = new AsyncLocalStorage<MetaCallContext>();

export function withMetaCallContext<T>(
  context: MetaCallContext,
  run: () => Promise<T>,
): Promise<T> {
  const parent = storage.getStore();
  return storage.run({ ...parent, ...context }, run);
}

export function currentMetaCallContext(): MetaCallContext {
  return storage.getStore() ?? {};
}
