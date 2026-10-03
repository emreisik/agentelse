import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NextStep } from "@/lib/journey";

import { NextStepBanner } from "./next-step-banner";

const step = (action: NextStep["action"], tone: NextStep["tone"] = "next"): NextStep => ({
  key: "k",
  tone,
  label: "Produce 5",
  title: "5 planned pieces have no content yet",
  action,
});

const render = (s: NextStep, workId?: string) =>
  renderToStaticMarkup(
    createElement(NextStepBanner, { projectId: "p1", step: s, workId }),
  );

// The bare project URL starts a new chat, whose own journey is empty and would
// run nothing: the banner opens the chat that holds the plan.
describe("NextStepBanner", () => {
  const produce = step({ kind: "produce_plan", planId: "plan1", count: 5 });

  it("opens the chat that holds the plan, and runs the step there once", () => {
    const html = render(produce, "w1");
    expect(html).toContain('href="/projects/p1?work=w1&amp;next=produce_plan"');
    expect(html).toContain("Produce 5");
    expect(html).toContain("5 planned pieces have no content yet");
  });

  it("without a Work (Works off, or a plan from before Works) the link is the plain one", () => {
    expect(render(produce)).toContain('href="/projects/p1?next=produce_plan"');
  });

  it("encodes the Work id", () => {
    expect(render(produce, "a b")).toContain("work=a%20b&amp;next=produce_plan");
  });

  it("steps that are plain pages ignore the Work", () => {
    expect(
      render(step({ kind: "review_queue", creativeId: "c9", count: 2 }), "w1"),
    ).toContain('href="/projects/p1/takvim?creative=c9"');
    expect(
      render(step({ kind: "connect_channel", channel: "instagram" }), "w1"),
    ).not.toContain("work=w1&amp;next");
  });

  it("marks a blocker", () => {
    expect(render(step({ kind: "show_results", count: 1 }, "blocker"))).toContain(
      "border-destructive/40",
    );
  });
});
