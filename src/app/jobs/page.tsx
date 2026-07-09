import { redirect } from "next/navigation";

export default async function JobsRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  qs.set("view", "jobs");
  for (const [key, value] of Object.entries(params)) {
    if (value) qs.set(key, value);
  }
  redirect(`/companies?${qs.toString()}`);
}
