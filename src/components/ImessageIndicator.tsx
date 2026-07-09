"use client";

import { useEffect, useState } from "react";

const POLL_MS = 3000;
const MAX_POLLS = 60; // ~3 minutes

export function ImessageIndicator({
  contactId,
  capable: initialCapable,
  personalEmail,
}: {
  contactId: string;
  capable: boolean | null;
  personalEmail: string | null;
}) {
  const [capable, setCapable] = useState(initialCapable);
  const [checking, setChecking] = useState(
    initialCapable == null && Boolean(personalEmail),
  );

  useEffect(() => {
    setCapable(initialCapable);
    if (initialCapable != null) setChecking(false);
  }, [initialCapable]);

  useEffect(() => {
    if (capable != null || !personalEmail) {
      setChecking(false);
      return;
    }

    let cancelled = false;
    setChecking(true);

    async function poll() {
      for (let attempt = 0; attempt < MAX_POLLS && !cancelled; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        try {
          const res = await fetch(`/api/contacts/${contactId}/imessage`, {
            cache: "no-store",
          });
          if (!res.ok) continue;
          const data = (await res.json()) as { imessage_capable: boolean | null };
          if (data.imessage_capable === true || data.imessage_capable === false) {
            if (!cancelled) {
              setCapable(data.imessage_capable);
              setChecking(false);
            }
            return;
          }
        } catch {
          // keep polling
        }
      }
      if (!cancelled) setChecking(false);
    }

    void poll();
    return () => {
      cancelled = true;
    };
  }, [contactId, personalEmail, capable]);

  if (!personalEmail) return null;

  if (capable === true) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200 font-medium">
        iMessage ✓
      </span>
    );
  }

  if (capable === false) {
    return <span className="text-[10px] text-gray-400">SMS only</span>;
  }

  if (checking) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[10px] text-gray-500">
        <span
          className="inline-block h-3 w-3 rounded-full border-2 border-gray-300 border-t-blue-600 animate-spin dark:border-gray-600 dark:border-t-blue-400"
          aria-hidden
        />
        Checking iMessage…
      </span>
    );
  }

  return (
    <span
      className="text-[10px] text-gray-400 italic"
      title="Mac worker checks iMessage every few minutes"
    >
      iMessage check queued
    </span>
  );
}
