"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CompanyCard, CompanyCardData } from "./CompanyCard";

export function RefreshableCompanyCard({
  company: initial,
}: {
  company: CompanyCardData;
}) {
  const router = useRouter();
  const [company, setCompany] = useState(initial);

  useEffect(() => {
    setCompany(initial);
  }, [initial]);

  async function handleEnrichComplete(updated?: CompanyCardData) {
    if (updated) {
      setCompany(updated);
    } else {
      const res = await fetch(`/api/companies/${initial.id}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as { company: CompanyCardData };
        setCompany(data.company);
      }
    }
    router.refresh();
  }

  return (
    <CompanyCard company={company} onEnrichComplete={handleEnrichComplete} />
  );
}
