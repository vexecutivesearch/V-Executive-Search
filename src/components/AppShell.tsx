"use client";

import { usePathname } from "next/navigation";
import { Nav } from "@/components/Nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isMarketingHome = pathname === "/";

  if (isMarketingHome) {
    return <>{children}</>;
  }

  return (
    <>
      <Nav />
      {/* overflow-x-clip prevents sideways page scroll on mobile without
          creating a scroll container (keeps sticky filter bars working). */}
      <main className="flex-1 overflow-x-clip">{children}</main>
    </>
  );
}
