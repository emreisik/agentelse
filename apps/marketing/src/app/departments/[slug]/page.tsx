import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DepartmentDetail } from "@/components/marketing/departments/department-detail";
import {
  DEPARTMENTS,
  getDepartment,
} from "@/components/marketing/departments/department-data";

type Props = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return DEPARTMENTS.map((department) => ({ slug: department.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const department = getDepartment(slug);

  if (!department) {
    return { title: "Department" };
  }

  return {
    title: department.name,
    description: `${department.tagline} ${department.description}`,
  };
}

export default async function DepartmentPage({ params }: Props) {
  const { slug } = await params;
  const department = getDepartment(slug);

  if (!department) {
    notFound();
  }

  return <DepartmentDetail department={department} />;
}
