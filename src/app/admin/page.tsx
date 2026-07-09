import { redirect } from "next/navigation";
import { isAdminAuthenticated } from "@/lib/admin-auth";
import { AdminDashboard } from "@/components/admin/AdminDashboard";
import { getOrCreateSettings } from "@/lib/pipeline-config";
import { db } from "@/lib/db";
import { searchProfiles } from "@/lib/db/schema";
import { asc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!(await isAdminAuthenticated())) {
    redirect("/admin/login");
  }

  const settings = await getOrCreateSettings();
  const profiles = await db
    .select()
    .from(searchProfiles)
    .orderBy(asc(searchProfiles.sortOrder));

  return <AdminDashboard settings={settings} profiles={profiles} />;
}
