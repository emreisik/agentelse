import { redirect } from "next/navigation";

// The workspace-wide Human Action page is gone: the few requests that still
// need a person are cards in the project chat. Old links land on the dashboard.
export default function HumanActionsRedirect() {
  redirect("/dashboard");
}
