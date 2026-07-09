"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, useState } from "react";

export function CompanySearch({ initialQuery }: { initialQuery?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(initialQuery ?? "");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    const term = q.trim();
    if (term) params.set("q", term);
    else params.delete("q");
    router.push(`/companies?${params.toString()}`);
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
