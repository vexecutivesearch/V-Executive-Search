"use client";

import { useEffect, useState } from "react";
import { CompanyCard, CompanyCardData } from "./CompanyCard";

export function RefreshableCompanyCard({
  company: initial,
  showLocationDisclaimer = false,
}: {
  company: CompanyCardData;
  showLocationDisclaimer?: boolean;
}) {
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
  }

  return (
    <CompanyCard
      company={company}
      onEnrichComplete={handleEnrichComplete}
      onStatusChange={(status) => setCompany((c) => ({ ...c, status }))}
      showLocationDisclaimer={showLocationDisclaimer}
    />
  );
}
