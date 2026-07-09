import { redirect } from "next/navigation";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { AdminDashboard } from "@/components/admin/AdminDashboard";
import { getAllSearchProfiles, getOrCreateSettings } from "@/lib/pipeline-config";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!(await isAdminAuthenticated())) {
    redirect("/admin/login");
  }

  const settings = await getOrCreateSettings();
  const profiles = await getAllSearchProfiles();

  return <AdminDashboard settings={settings} profiles={profiles} />;
}
