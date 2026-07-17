"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/crm", label: "Pipeline" },
  { href: "/runs", label: "Runs" },
  { href: "/legacy", label: "Legacy" },
  { href: "/admin", label: "Admin" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-950/80 backdrop-blur sticky top-0 z-20">
      <div className="max-w-6xl mx-auto px-3 sm:px-4 py-3 flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/legacy"
          className="shrink-0 leading-none"
          aria-label="allthejobs home"
        >
          <Image
            src="/allthejobs-logo.png"
            alt="allthejobs"
            width={952}
            height={309}
            className="h-8 w-auto dark:invert"
            priority
          />
        </Link>
        <nav className="flex flex-wrap justify-end gap-0.5 sm:gap-1">
          {NAV.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`px-2 sm:px-3 py-1.5 rounded-md text-xs sm:text-sm transition-colors ${
                  active
                    ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900 font-medium"
                    : "text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
