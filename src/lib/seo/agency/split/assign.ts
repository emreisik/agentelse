import { seededRandom } from "@/lib/seo/actions/did";
import { MIN_PRE_WEEKS } from "@/lib/seo/actions/windows";

// Bölünmüş testin atama kuralı (docs/google-search-console-plan.md §6.4,
// SC-F9): şablon siteler, benzer sayfalar, her sayfa grubunun KENDİ içinde
// rastgele iki yarı. Kademelendirme ve 100 sayfa tabanı GRUP başınadır; her
// grup kendi içinde dengelenir, böylece bir grubun trafiği tek bir kola
// yığılmaz. Saf; Math.random yok, tohum test kimliğidir.

export const SPLIT_MIN_GROUP_PAGES = 100;
// Değerlendirmede bir kolun kullanılabilir sayfa tabanı (toplam, gruplar dahil).
export const SPLIT_MIN_ARM_TOTAL = 50;
export const SPLIT_RECOMMENDED_ARM = 100;
export const SPLIT_MAX_PAGES = 4000;
export const SPLIT_MAX_GROUPS = 5;
export const SPLIT_MIN_PRE_CLICKS = 100;
export const SPLIT_MAX_OPEN_PER_LINK = 3;
export const SPLIT_CMS_MAX_ARM = 60;

export type SplitCandidate = {
  pageId: string;
  group: string;
  preClicks: number;
  preImpressions: number;
};

export type SplitEligibility =
  | {
      ok: true;
      arms: { test: number; control: number };
      perGroup: { group: string; test: number; control: number }[];
      recommended: boolean;
    }
  | { ok: false; reason: "NO_HISTORY" | "TOO_FEW_PAGES" | "LOW_TRAFFIC" };

export const SPLIT_ERROR_TEXT: Record<
  "NO_HISTORY" | "TOO_FEW_PAGES" | "LOW_TRAFFIC",
  string
> = {
  NO_HISTORY:
    "We need at least four weeks of page data before a test can start.",
  TOO_FEW_PAGES:
    "Each page group needs at least 100 pages with search traffic.",
  LOW_TRAFFIC: "These pages don't get enough search clicks to measure a test.",
};

function byClicksThenId(a: SplitCandidate, b: SplitCandidate): number {
  return (
    b.preClicks - a.preClicks ||
    (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : 0)
  );
}

// Gösterimi olan sayfalar, tıklamaya göre ilk SPLIT_MAX_PAGES.
function cappedCandidates(
  candidates: readonly SplitCandidate[],
  groups?: ReadonlySet<string>,
): SplitCandidate[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.preImpressions > 0 &&
        (groups === undefined || groups.has(candidate.group)),
    )
    .sort(byClicksThenId)
    .slice(0, SPLIT_MAX_PAGES);
}

function groupsOf(
  candidates: readonly SplitCandidate[],
): Map<string, SplitCandidate[]> {
  const groups = new Map<string, SplitCandidate[]>();
  for (const candidate of candidates) {
    const list = groups.get(candidate.group) ?? [];
    list.push(candidate);
    groups.set(candidate.group, list);
  }
  return groups;
}

export function assignArms(input: {
  candidates: readonly SplitCandidate[];
  seed: string;
}): {
  test: string[];
  control: string[];
  perGroup: { group: string; test: number; control: number }[];
  balance: { testClicks: number; controlClicks: number; ratio: number };
} {
  const pool = cappedCandidates(input.candidates);
  const groups = groupsOf(pool);
  const test: string[] = [];
  const control: string[] = [];
  const perGroup: { group: string; test: number; control: number }[] = [];
  let testClicks = 0;
  let controlClicks = 0;

  for (const group of [...groups.keys()].sort()) {
    const members = [...(groups.get(group) ?? [])].sort(byClicksThenId);
    const random = seededRandom(`${input.seed}:${group}`);
    let groupTest = 0;
    let groupControl = 0;
    const put = (candidate: SplitCandidate, toTest: boolean) => {
      if (toTest) {
        test.push(candidate.pageId);
        testClicks += candidate.preClicks;
        groupTest += 1;
      } else {
        control.push(candidate.pageId);
        controlClicks += candidate.preClicks;
        groupControl += 1;
      }
    };
    // Komşu çiftler: tıklamaca en yakın iki sayfa farklı kollara düşer.
    for (let index = 0; index + 1 < members.length; index += 2) {
      const first = members[index]!;
      const second = members[index + 1]!;
      const firstToTest = random() < 0.5;
      put(first, firstToTest);
      put(second, !firstToTest);
    }
    if (members.length % 2 === 1) {
      put(members[members.length - 1]!, random() < 0.5);
    }
    perGroup.push({ group, test: groupTest, control: groupControl });
  }

  const high = Math.max(testClicks, controlClicks);
  const ratio = high === 0 ? 1 : Math.min(testClicks, controlClicks) / high;
  return {
    test: test.sort(),
    control: control.sort(),
    perGroup,
    balance: { testClicks, controlClicks, ratio },
  };
}

export function splitEligibility(input: {
  candidates: readonly SplitCandidate[];
  groups: readonly string[];
  preWeeksCovered: number;
}): SplitEligibility {
  if (input.preWeeksCovered < MIN_PRE_WEEKS) {
    return { ok: false, reason: "NO_HISTORY" };
  }
  const wanted = new Set(input.groups);
  // Üst sınır tabandan ÖNCE uygulanır: kesilen sayfalar gruptan düşer.
  const pool = cappedCandidates(input.candidates, wanted);
  const perGroupPages = groupsOf(pool);
  if (wanted.size === 0 || wanted.size > SPLIT_MAX_GROUPS) {
    return { ok: false, reason: "TOO_FEW_PAGES" };
  }
  for (const group of wanted) {
    if ((perGroupPages.get(group)?.length ?? 0) < SPLIT_MIN_GROUP_PAGES) {
      return { ok: false, reason: "TOO_FEW_PAGES" };
    }
  }
  const clicks = pool.reduce((sum, candidate) => sum + candidate.preClicks, 0);
  if (clicks < SPLIT_MIN_PRE_CLICKS)
    return { ok: false, reason: "LOW_TRAFFIC" };

  // Kol sayıları, sabit bir önizleme tohumuyla hesaplanır; gerçek atamada
  // tek sayılı grupların artan sayfası bir sayfa farkla öbür tarafa düşebilir.
  const preview = assignArms({ candidates: pool, seed: "preview" });
  const arms = { test: preview.test.length, control: preview.control.length };
  return {
    ok: true,
    arms,
    perGroup: preview.perGroup,
    recommended: Math.min(arms.test, arms.control) >= SPLIT_RECOMMENDED_ARM,
  };
}
