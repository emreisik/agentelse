import type { FunnelDefinition, FunnelRange, FunnelStep } from "./types";

// v1alpha runFunnelReport istek gövdesi (GA-F8). Şekil Google'ın v1alpha
// discovery belgesinden doğrulandı (bkz. request.test.ts başlığı): adım =
// { name, filterExpression }; filterExpression olay için `funnelEventFilter`,
// sayfa yolu için `funnelFieldFilter` taşır. Saf modül.

export type FunnelFilterExpression =
  | { funnelEventFilter: { eventName: string } }
  | {
      funnelFieldFilter: {
        fieldName: string;
        stringFilter: { matchType: "EXACT"; value: string };
      };
    };

export type FunnelRequestStep = {
  name: string;
  filterExpression: FunnelFilterExpression;
};

export type FunnelRequestBody = {
  dateRanges: FunnelRange[];
  funnel: { isOpenFunnel: boolean; steps: FunnelRequestStep[] };
  returnPropertyQuota: true;
};

function stepBody(step: FunnelStep): FunnelRequestStep {
  if (step.kind === "event") {
    return {
      name: step.name,
      filterExpression: { funnelEventFilter: { eventName: step.value } },
    };
  }
  return {
    name: step.name,
    filterExpression: {
      funnelFieldFilter: {
        fieldName: "pagePath",
        stringFilter: { matchType: "EXACT", value: step.value },
      },
    },
  };
}

export function buildFunnelRequest(
  definition: Pick<FunnelDefinition, "isOpen" | "steps">,
  range: FunnelRange,
): FunnelRequestBody {
  return {
    dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
    funnel: {
      isOpenFunnel: definition.isOpen,
      steps: definition.steps.map(stepBody),
    },
    returnPropertyQuota: true,
  };
}
