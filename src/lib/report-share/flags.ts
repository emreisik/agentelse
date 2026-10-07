// Rapor paylaşımı bayrağı (SC-F9 ve GA-F8 ortak). Değer çağrı anında okunur;
// yalnız tam "true" açar. İki iz de aynı /r/[token] sayfasını ve saklama
// adımını kullandığı için bayrak ikisinden birinin açık olmasıdır.

export type ReportShareEnvironment = {
  GSC_AGENCY?: string;
  GA_AGENCY?: string;
} & Record<string, string | undefined>;

export function reportShareOn(
  env: ReportShareEnvironment = process.env,
): boolean {
  return env.GSC_AGENCY === "true" || env.GA_AGENCY === "true";
}
