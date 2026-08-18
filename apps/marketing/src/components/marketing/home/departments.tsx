import { Reveal } from "@/components/marketing/reveal";
import { Section } from "@/components/marketing/section";
import {
  DepartmentExplorer,
  type Department,
} from "@/components/marketing/home/department-explorer";

const DEPARTMENTS: Department[] = [
  { id: "director", name: "Agency Director" },
  { id: "research", name: "Research" },
  { id: "idea-foundry", name: "Idea Foundry" },
  { id: "creative", name: "Creative" },
  { id: "seo", name: "SEO" },
  { id: "social", name: "Social" },
  { id: "analytics", name: "Analytics" },
  { id: "opportunity-engine", name: "Opportunity Engine" },
];

export function Departments() {
  return (
    <Section>
      <Reveal>
        <p className="agentelse-text-caption font-medium text-muted-foreground uppercase">
          19 departments, one team
        </p>
        <h2 className="agentelse-text-h2 mt-5 max-w-2xl text-foreground">
          Specialists when you need them.
          <br />
          One team all the time.
        </h2>
        <p className="agentelse-text-lead mt-4 max-w-xl text-muted-foreground">
          Every department reports to the same Agency Director. Click one to see
          it live.
        </p>
      </Reveal>

      <Reveal delayMs={100} className="mt-12">
        <DepartmentExplorer departments={DEPARTMENTS} />
      </Reveal>
    </Section>
  );
}
