"use client";

import Link from "next/link";
import { useState } from "react";
import { AnalyticsTab } from "./AnalyticsTab";
import { ApprovalsTab } from "./ApprovalsTab";
import { DomainsTab } from "./DomainsTab";
import { EnrollmentsTab } from "./EnrollmentsTab";
import { OverviewTab } from "./OverviewTab";
import { RepliesTab } from "./RepliesTab";
import { SuppressionsTab } from "./SuppressionsTab";
import { TemplatesTab } from "./TemplatesTab";

const TABS = [
  { id: "overview", label: "Overview & switches" },
  { id: "approvals", label: "Approvals" },
  { id: "enrollments", label: "Enrollments" },
  { id: "templates", label: "Templates" },
  { id: "replies", label: "Replies" },
  { id: "suppressions", label: "Suppressions" },
  { id: "domains", label: "Domains" },
  { id: "analytics", label: "Analytics" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function OutreachDashboard() {
  const [tab, setTab] = useState<TabId>("overview");

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-1">
        <h1 className="text-2xl font-bold">Outreach Sequencer</h1>
        <div className="flex gap-2">
          <Link
            href="/admin/outreach/flows"
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 hover:opacity-90"
          >
            Flow builder →
          </Link>
          <Link
            href="/admin"
            className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900"
          >
            ← Admin
          </Link>
        </div>
      </div>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-5 max-w-3xl">
        Reply-aware email + iMessage sequences. Enrolled contacts get a 10-day cadence
        drafted per-contact from your winning templates; every inbound reply is classified
        and routed by the rule engine. Ships OFF + dry-run + approval-gated.
      </p>

      <div className="flex flex-wrap gap-1.5 mb-5">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium ${
              tab === t.id
                ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                : "border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "approvals" && <ApprovalsTab />}
      {tab === "enrollments" && <EnrollmentsTab />}
      {tab === "templates" && <TemplatesTab />}
      {tab === "replies" && <RepliesTab />}
      {tab === "suppressions" && <SuppressionsTab />}
      {tab === "domains" && <DomainsTab />}
      {tab === "analytics" && <AnalyticsTab />}
    </div>
  );
}
