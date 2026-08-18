import {
  FlowDiagram,
  type FlowEdge,
  type FlowNode,
} from "@/components/marketing/flow-diagram";
import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";

const NODES: FlowNode[] = [
  { id: "company", label: "Company", kind: "hub", x: 50, y: 15 },
  {
    id: "brand-a",
    label: "Brand A",
    sublabel: "Brand Brain · Departments",
    kind: "node",
    x: 20,
    y: 80,
  },
  {
    id: "brand-b",
    label: "Brand B",
    sublabel: "Brand Brain · Departments",
    kind: "node",
    x: 50,
    y: 80,
  },
  {
    id: "brand-c",
    label: "Brand C",
    sublabel: "Brand Brain · Departments",
    kind: "node",
    x: 80,
    y: 80,
  },
];

const EDGES: FlowEdge[] = [
  { id: "company-brand-a", from: "company", to: "brand-a", animated: true },
  { id: "company-brand-b", from: "company", to: "brand-b", animated: true },
  { id: "company-brand-c", from: "company", to: "brand-c", animated: true },
];

export function MultiBrand() {
  return (
    <Section tone="raised">
      <Reveal>
        <h2 className="agentelse-text-h2 max-w-2xl text-foreground">
          One organization.
          <br />
          Every brand has its own brain.
        </h2>
      </Reveal>

      <Reveal delayMs={80} className="mt-12">
        <FlowDiagram
          nodes={NODES}
          edges={EDGES}
          viewBox={{ width: 900, height: 360 }}
          ariaLabel="A single Company node branches down into three independently-run brands — Brand A, Brand B and Brand C — each with its own Brand Brain and departments."
        />
      </Reveal>

      <Reveal delayMs={140} className="mt-10">
        <p className="agentelse-text-lead max-w-[60ch] text-muted-foreground">
          Each brand keeps its own Brand Brain, departments, integrations,
          rules, analytics, competitors and approvals — fully separate. As the
          company owner, you see everything from one executive layer.
        </p>
      </Reveal>
    </Section>
  );
}
