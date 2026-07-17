"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";

export type PreviewLead = {
  id: string;
  name: string;
  domain: string | null;
  score: number;
  icpScore: number | null;
  roleType: string | null;
  marketLabel: string | null;
  jobTitle: string | null;
  jobBoard: string | null;
  jobLocation: string | null;
  salary: string | null;
  sector: string | null;
  contactsCallable: number;
  contactsTotal: number;
  discovered: number;
  hot: boolean;
  onList: boolean;
  reasonToCall: string | null;
};

export type PreviewListing = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  board: string | null;
  market: string | null;
  reposts: number;
  postedAt: string;
};

export type PreviewCallItem = {
  id: string;
  company: string;
  score: number;
  contactName: string | null;
  contactTitle: string | null;
  status: string;
  attempts: number;
  nextFollowUp: string | null;
  assignedTo: string | null;
  market: string | null;
};

export type PreviewData = {
  live: boolean;
  kpis: {
    totalCompanies: number;
    newToday: number;
    enriched: number;
    hot: number;
    dueToday: number;
    totalListings: number;
  };
  counts: { allLeads: number; hot: number; callList: number };
  totalLocations: number;
  states: Array<{
    stateName: string;
    stateAbbr: string;
    count: number;
    cities: Array<{ city: string; count: number }>;
  }>;
  leads: PreviewLead[];
  listings: PreviewListing[];
  callList: PreviewCallItem[];
};

type Tab = "all" | "listings" | "call-list" | "hot";

function ringClass(score: number): string {
  if (score >= 80) return "nu-ring nu-ring-high";
  if (score >= 60) return "nu-ring nu-ring-mid";
  return "nu-ring nu-ring-low";
}

const DOT = [
  "#818cf8",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#38bdf8",
  "#fb923c",
  "#a78bfa",
  "#4ade80",
];

export function NewUiApp({ data }: { data: PreviewData }) {
  const [tab, setTab] = useState<Tab>("all");
  const [activeState, setActiveState] = useState<string>("");
  const [search, setSearch] = useState("");

  const kpiCards = [
    { label: "Total companies", value: data.kpis.totalCompanies, hint: data.kpis.newToday > 0 ? `+${data.kpis.newToday.toLocaleString()} today` : "all markets" },
    { label: "Enriched", value: data.kpis.enriched, hint: `${data.kpis.totalCompanies ? ((100 * data.kpis.enriched) / data.kpis.totalCompanies).toFixed(1) : "0"}% of pipeline` },
    { label: "Hot signals", value: data.kpis.hot, hint: "active hiring signals" },
    { label: "Due today", value: data.kpis.dueToday, hint: "call-list follow-ups" },
  ];

  const leads = useMemo(() => {
    const term = search.trim().toLowerCase();
    return data.leads.filter((l) => {
      if (tab === "hot" && !l.hot) return false;
      if (activeState && !l.marketLabel?.toUpperCase().endsWith(`, ${activeState}`)) {
        return false;
      }
      if (!term) return true;
      return `${l.name} ${l.jobTitle ?? ""} ${l.marketLabel ?? ""}`
        .toLowerCase()
        .includes(term);
    });
  }, [data.leads, tab, activeState, search]);

  return (
    <div className="min-h-full pb-20">
      {/* ---- Nav (frosted glass) ---- */}
      <header className="nu-glass sticky top-0 z-30 rounded-none border-x-0 border-t-0">
        <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Image
              src="/allthejobs-logo.png"
              alt="allthejobs"
              width={952}
              height={309}
              className="h-7 w-auto"
              style={{ filter: "brightness(0) invert(1)" }}
              priority
            />
            <span className="nu-pill nu-pill-icp">Dark glass preview</span>
          </div>
          <nav className="flex items-center gap-1.5 text-sm">
            <span className="nu-chip nu-chip-active px-3 py-1.5 rounded-md">Pipeline</span>
            <span className="nu-chip px-3 py-1.5 rounded-md">Runs</span>
            <span className="nu-chip px-3 py-1.5 rounded-md">Admin</span>
            <Link
              href="/crm"
              className="ml-2 px-3 py-1.5 rounded-md text-xs"
              style={{ color: "var(--nu-muted)", textDecoration: "underline" }}
            >
              ← Back to live app
            </Link>
          </nav>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 pt-6">
        <div className="mb-5">
          <h1 className="text-2xl font-bold" style={{ color: "var(--nu-text)" }}>
            Pipeline
          </h1>
          <p className="mt-1 text-sm" style={{ color: "var(--nu-muted)" }}>
            All markets · all dates · independent of the Admin scrape and today&apos;s
            date. {data.live ? "" : "Sample data — connect a database for live numbers."}
          </p>
        </div>

        {/* ---- KPI tiles (glass) ---- */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          {kpiCards.map((c) => (
            <div key={c.label} className="nu-glass rounded-2xl px-4 py-3">
              <p className="text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--nu-faint)" }}>
                {c.label}
              </p>
              <p className="text-2xl font-bold tabular-nums mt-1" style={{ color: "var(--nu-text)" }}>
                {c.value.toLocaleString()}
              </p>
              <p className="text-xs mt-0.5" style={{ color: "var(--nu-muted)" }}>
                {c.hint}
              </p>
            </div>
          ))}
        </div>

        {/* ---- Tabs + export ---- */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex flex-wrap gap-2">
            {([
              ["all", `All leads (${data.counts.allLeads.toLocaleString()})`],
              ["listings", `Job listings (${data.kpis.totalListings.toLocaleString()})`],
              ["call-list", `Call list (${data.counts.callList})`],
              ["hot", `Hot (${data.counts.hot})`],
            ] as [Tab, string][]).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`px-3 py-1.5 rounded-full text-sm ${
                  tab === id ? "nu-chip nu-chip-active" : "nu-chip"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="nu-accent-btn px-3 py-1.5 rounded-md text-sm">
            ↓ Export CSV
          </button>
        </div>

        <div className="flex gap-6">
          {/* ---- Location rail (glass) ---- */}
          {tab !== "call-list" && (
            <nav className="hidden lg:block w-56 shrink-0 self-start sticky top-[5rem]">
              <div className="nu-glass rounded-2xl p-2.5">
                <p className="text-[10px] font-medium uppercase tracking-wider px-2 mb-1.5" style={{ color: "var(--nu-faint)" }}>
                  Locations
                </p>
                <button
                  type="button"
                  onClick={() => setActiveState("")}
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-sm ${
                    !activeState ? "nu-chip-active" : ""
                  }`}
                  style={!activeState ? {} : { color: "var(--nu-muted)" }}
                >
                  <span>All locations</span>
                  <span className="text-xs opacity-70 tabular-nums">
                    {data.totalLocations.toLocaleString()}
                  </span>
                </button>
                <div className="mt-1 space-y-0.5 max-h-[60vh] overflow-y-auto pr-1">
                  {data.states.map((s, i) => (
                    <button
                      key={s.stateAbbr}
                      type="button"
                      onClick={() =>
                        setActiveState(activeState === s.stateAbbr ? "" : s.stateAbbr)
                      }
                      className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-sm ${
                        activeState === s.stateAbbr ? "nu-chip-active" : ""
                      }`}
                      style={
                        activeState === s.stateAbbr ? {} : { color: "var(--nu-muted)" }
                      }
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{ background: DOT[i % DOT.length] }}
                        />
                        <span className="truncate">{s.stateName}</span>
                      </span>
                      <span className="text-xs opacity-70 tabular-nums">
                        {s.count.toLocaleString()}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </nav>
          )}

          <div className="flex-1 min-w-0">
            {tab === "call-list" ? (
              <CallListTable items={data.callList} />
            ) : tab === "listings" ? (
              <ListingsTable rows={data.listings} />
            ) : (
              <>
                {/* Filter bar (glass) */}
                <div className="nu-glass rounded-2xl px-3 py-2.5 mb-3 flex flex-wrap items-center gap-2">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search company, job, contact…"
                    className="nu-input flex-1 min-w-[12rem] text-sm rounded-md px-3 py-1.5"
                  />
                  {["All states", "All cities", "All sectors", "Sort: ICP fit"].map(
                    (label) => (
                      <span
                        key={label}
                        className="nu-input text-sm rounded-md px-2.5 py-1.5"
                        style={{ color: "var(--nu-muted)" }}
                      >
                        {label} ▾
                      </span>
                    ),
                  )}
                </div>
                <LeadsTable leads={leads} />
              </>
            )}
          </div>
        </div>

        <p className="mt-8 text-center text-xs" style={{ color: "var(--nu-faint)" }}>
          Preview only · dark glassmorphic theme on <code>/newui</code> · not wired to
          production actions
        </p>
      </div>
    </div>
  );
}

function LeadsTable({ leads }: { leads: PreviewLead[] }) {
  return (
    <div className="nu-solid rounded-2xl overflow-hidden">
      <div className="hidden sm:grid grid-cols-[3.5rem_minmax(0,1.3fr)_minmax(0,1.3fr)_7rem_5rem_auto] gap-x-3 px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--nu-faint)", borderBottom: "1px solid var(--nu-line)" }}>
        <span>Score</span>
        <span>Company</span>
        <span>Job</span>
        <span>Location</span>
        <span>Contacts</span>
        <span className="text-right pr-2">Action</span>
      </div>
      {leads.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm" style={{ color: "var(--nu-faint)" }}>
          No leads match — try clearing the state filter.
        </p>
      ) : (
        leads.map((l) => (
          <div
            key={l.id}
            className="nu-row grid grid-cols-[3rem_1fr_auto] sm:grid-cols-[3.5rem_minmax(0,1.3fr)_minmax(0,1.3fr)_7rem_5rem_auto] gap-x-3 gap-y-1 items-center px-3 sm:px-4 py-2.5"
          >
            <div className={`${ringClass(l.score)} h-10 w-10 text-sm`}>{l.score}</div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium truncate" style={{ color: "var(--nu-text)" }}>
                  {l.name}
                </span>
                {l.onList && <span className="nu-pill nu-pill-onlist">On list</span>}
                {l.hot && <span className="nu-pill nu-pill-hot">Hot</span>}
                {l.contactsCallable > 0 && (
                  <span className="nu-pill nu-pill-enriched">Enriched</span>
                )}
                {l.discovered > 0 && (
                  <span className="nu-pill nu-pill-discovered">
                    Discovered {l.discovered}
                  </span>
                )}
                {l.icpScore != null && (
                  <span className="nu-pill nu-pill-icp">ICP {l.icpScore}</span>
                )}
              </div>
              <p className="text-xs truncate" style={{ color: "var(--nu-faint)" }}>
                {l.domain ?? l.sector ?? ""}
                {l.reasonToCall ? ` · ${l.reasonToCall}` : ""}
              </p>
            </div>
            <div className="hidden sm:block min-w-0">
              <p className="text-sm truncate" style={{ color: "var(--nu-text)" }}>
                {l.jobTitle ?? "No active job"}
              </p>
              <p className="text-xs truncate" style={{ color: "var(--nu-faint)" }}>
                {[l.jobBoard, l.salary].filter(Boolean).join(" · ")}
              </p>
            </div>
            <div className="hidden sm:block text-xs truncate" style={{ color: "var(--nu-muted)" }}>
              {l.jobLocation ?? l.marketLabel ?? "—"}
            </div>
            <div className="hidden sm:block text-sm tabular-nums" style={{ color: "var(--nu-muted)" }}>
              {l.contactsTotal > 0 ? `${l.contactsCallable}/${l.contactsTotal}` : "—"}
            </div>
            <div className="flex justify-end pr-1">
              <button
                type="button"
                className={
                  l.onList
                    ? "px-3 py-1.5 rounded-md text-xs font-medium nu-chip"
                    : l.contactsCallable > 0
                      ? "px-3 py-1.5 rounded-md text-xs nu-accent-btn"
                      : "px-3 py-1.5 rounded-md text-xs nu-accent-btn"
                }
              >
                {l.onList ? "Open" : l.contactsCallable > 0 ? "Add to Call List" : "Find contacts"}
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ListingsTable({ rows }: { rows: PreviewListing[] }) {
  return (
    <div className="nu-solid rounded-2xl overflow-hidden overflow-x-auto">
      <table className="w-full text-sm min-w-[46rem]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider" style={{ color: "var(--nu-faint)" }}>
            <th className="px-3 py-2.5">Posted</th>
            <th className="px-3 py-2.5">Title</th>
            <th className="px-3 py-2.5">Company</th>
            <th className="px-3 py-2.5">Location</th>
            <th className="px-3 py-2.5">Board</th>
            <th className="px-3 py-2.5 text-right">Contacts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="nu-row">
              <td className="px-3 py-2.5 whitespace-nowrap text-xs" style={{ color: "var(--nu-faint)" }}>
                {new Date(r.postedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </td>
              <td className="px-3 py-2.5" style={{ color: "var(--nu-text)" }}>
                {r.title}
                {r.reposts > 1 && (
                  <span className="nu-pill nu-pill-hot ml-2">reposted {r.reposts}×</span>
                )}
              </td>
              <td className="px-3 py-2.5" style={{ color: "var(--nu-muted)" }}>
                {r.company}
                {r.market && (
                  <span className="block text-[10px]" style={{ color: "var(--nu-faint)" }}>
                    {r.market}
                  </span>
                )}
              </td>
              <td className="px-3 py-2.5 text-xs" style={{ color: "var(--nu-muted)" }}>
                {r.location ?? "—"}
              </td>
              <td className="px-3 py-2.5">
                <span className="nu-pill nu-pill-neutral lowercase">{r.board ?? "—"}</span>
              </td>
              <td className="px-3 py-2.5 text-right">
                <button type="button" className="nu-accent-btn px-2.5 py-1 rounded-md text-xs">
                  Find contacts
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CallListTable({ items }: { items: PreviewCallItem[] }) {
  return (
    <div className="nu-solid rounded-2xl overflow-hidden">
      <div className="hidden lg:grid grid-cols-[3.25rem_minmax(0,1.3fr)_minmax(0,1.2fr)_10rem_4rem_7rem_minmax(0,0.6fr)] gap-x-3 px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider" style={{ color: "var(--nu-faint)", borderBottom: "1px solid var(--nu-line)" }}>
        <span>Score</span>
        <span>Company</span>
        <span>Contact</span>
        <span>Status</span>
        <span>Att.</span>
        <span>Follow-up</span>
        <span>Assigned</span>
      </div>
      {items.map((c) => (
        <div
          key={c.id}
          className="nu-row grid grid-cols-[3rem_1fr] lg:grid-cols-[3.25rem_minmax(0,1.3fr)_minmax(0,1.2fr)_10rem_4rem_7rem_minmax(0,0.6fr)] gap-x-3 gap-y-1 items-center px-3 sm:px-4 py-2.5"
        >
          <div className={`${ringClass(c.score)} h-10 w-10 text-sm`}>{c.score}</div>
          <div className="min-w-0">
            <p className="font-medium truncate" style={{ color: "var(--nu-text)" }}>
              {c.company}
            </p>
            <p className="text-xs truncate" style={{ color: "var(--nu-faint)" }}>
              {c.market ?? ""}
            </p>
          </div>
          <div className="hidden lg:block min-w-0">
            <p className="text-sm truncate" style={{ color: "var(--nu-text)" }}>
              {c.contactName ?? "—"}
            </p>
            <p className="text-xs truncate" style={{ color: "var(--nu-faint)" }}>
              {c.contactTitle ?? ""}
            </p>
          </div>
          <div className="hidden lg:block">
            <span className="nu-pill nu-pill-status">{c.status}</span>
          </div>
          <div className="hidden lg:block text-sm tabular-nums" style={{ color: "var(--nu-muted)" }}>
            {c.attempts}
          </div>
          <div className="hidden lg:block text-xs tabular-nums" style={{ color: "var(--nu-muted)" }}>
            {c.nextFollowUp ?? "—"}
          </div>
          <div className="hidden lg:block text-xs truncate" style={{ color: "var(--nu-muted)" }}>
            {c.assignedTo ?? "—"}
          </div>
        </div>
      ))}
    </div>
  );
}
