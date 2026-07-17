"use client";

import { useEffect, useState } from "react";

/**
 * Light/dark toggle. Dark mode is class-based (`.dark` on <html>) and
 * persisted in localStorage; light is the default. The no-flash init runs
 * from an inline script in the root layout before paint.
 */
function currentIsDark(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

export function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Sync from the DOM (set pre-paint by the layout's no-flash script).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMounted(true);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsDark(currentIsDark());
  }, []);

  function toggle() {
    const next = !isDark;
    setIsDark(next);
    const root = document.documentElement;
    root.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      // ignore storage failures (private mode)
    }
  }

  const showDark = mounted && isDark;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={showDark ? "Switch to light mode" : "Switch to dark mode"}
      title={showDark ? "Switch to light mode" : "Switch to dark mode"}
      className="ml-1 sm:ml-2 inline-flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-md border border-gray-300 dark:border-gray-600 text-xs sm:text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
    >
      {showDark ? (
        // Sun
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        // Moon
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
      <span>{showDark ? "Light" : "Dark"}</span>
    </button>
  );
}
