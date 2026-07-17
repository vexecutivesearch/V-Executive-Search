"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useState, useTransition } from "react";
import type { CompanyStatus } from "@/lib/db/schema";

export function CompanySearch({
  initialQuery,
  view = "leads",
  status,
}: {
  initialQuery?: string;
  view?: "leads" | "jobs";
  status?: CompanyStatus;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(initialQuery ?? "");
  const [, startTransition] = useTransition();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", view);
    const term = q.trim();
    if (term) params.set("q", term);
    else params.delete("q");
    if (status) params.set("status", status);
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex gap-2 mb-4">
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search company name or domain…"
        className="flex-1 text-sm border border-gray-200 dark:border-gray-700 rounded-md px-3 py-2 bg-white dark:bg-gray-900"
      />
      <button
        type="submit"
        className="px-4 py-2 text-sm rounded-md bg-gray-900 text-white dark:bg-white dark:text-gray-900"
      >
        Search
      </button>
    </form>
  );
}
