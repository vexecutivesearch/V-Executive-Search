import { redirect } from "next/navigation";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { FlowBuilder } from "@/components/admin/outreach/FlowBuilder";

export const dynamic = "force-dynamic";

export default async function AdminOutreachFlowsPage() {
  if (!(await isAdminAuthenticated())) {
    redirect("/admin/login");
  }
  return <FlowBuilder />;
}
