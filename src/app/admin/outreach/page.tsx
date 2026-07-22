import { redirect } from "next/navigation";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { OutreachDashboard } from "@/components/admin/outreach/OutreachDashboard";

export const dynamic = "force-dynamic";

export default async function AdminOutreachPage() {
  if (!(await isAdminAuthenticated())) {
    redirect("/admin/login");
  }
  return <OutreachDashboard />;
}
