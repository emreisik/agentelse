import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SolutionDetail } from "@/components/marketing/solutions/solution-detail";
import {
  SOLUTIONS,
  getSolutionBySlug,
} from "@/components/marketing/solutions/solution-data";

type SolutionPageProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return SOLUTIONS.map((solution) => ({ slug: solution.slug }));
}

export async function generateMetadata({
  params,
}: SolutionPageProps): Promise<Metadata> {
  const { slug } = await params;
  const solution = getSolutionBySlug(slug);

  if (!solution) {
    return { title: "Solutions" };
  }

  return {
    title: solution.audience,
    description: solution.problem,
  };
}

export default async function SolutionPage({ params }: SolutionPageProps) {
  const { slug } = await params;
  const solution = getSolutionBySlug(slug);

  if (!solution) {
    notFound();
  }

  return <SolutionDetail solution={solution} />;
}
