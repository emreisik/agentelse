import { redirect } from "next/navigation";

// Old departments page. The departments panel is gone (its mode setting had no
// effect in the chat-first flow); old bookmarks land on the project.
export default async function DepartmanlarRedirect({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(`/projects/${projectId}`);
}
