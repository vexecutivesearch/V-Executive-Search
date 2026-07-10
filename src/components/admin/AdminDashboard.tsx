"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { GeographicScope, PipelineSettings, SearchProfile } from "@/lib/db/schema";
import type { EmailReportPreferences } from "@/lib/email-report-preferences";
import {
  normalizeEmailReportPreferences,
} from "@/lib/email-report-preferences";
import type { TodayFilterOptions } from "@/lib/filter-options";
import {
  JOB_BOARD_OPTIONS,
  resolveJobBoards,
  type JobBoardId,
} from "@/lib/job-boards";
import {
  getCitiesForState,
  getCountiesForState,
  getMetroCitiesForState,
  US_STATES,
} from "@/lib/locations";
import { DEFAULT_WPB_METRO_ALIASES } from "@/lib/metro-defaults";

const SCOPES: { value: GeographicScope; label: string }[] = [
  { value: "national", label: "National (United States)" },
  { value: "state", label: "State" },
  { value: "city", label: "City" },
  { value: "county", label: "County" },
];

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  emptyHint,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  emptyHint?: string;
}) {
  function toggle(value: string) {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  }

  return (
    <div className="block text-sm">
      <span className="font-medium">{label}</span>
      {selected.length > 0 && (
        <p className="mt-1 text-xs text-gray-500">
          Selected: {selected.join(", ")}
        </p>
      )}
      {options.length === 0 ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          {emptyHint ?? "No predefined locations for this state yet."}
        </p>
      ) : (
        <div className="mt-2 max-h-48 overflow-y-auto border rounded-lg p-2 space-y-1 dark:border-gray-700">
          {options.map((option) => (
            <label
              key={option}
              className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={() => toggle(option)}
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdminDashboard({
  settings,
  profiles: initialProfiles,
  filterOptions,
}: {
  settings: PipelineSettings;
  profiles: SearchProfile[];
  filterOptions: TodayFilterOptions;
}) {
  const router = useRouter();
  const initialCities =
    settings.focusCities?.length
      ? settings.focusCities
      : settings.focusCity
        ? [settings.focusCity]
        : [];
  const initialCounties =
    settings.focusCounties?.length
      ? settings.focusCounties
      : settings.focusCounty
        ? [settings.focusCounty]
        : [];

  const initialMetro =
    settings.metroCities?.length ? settings.metroCities : [];

  const [form, setForm] = useState({
    geographic_scope: settings.geographicScope,
    focus_state: settings.focusState ?? "Florida",
    focus_cities: initialCities,
    focus_counties: initialCounties,
    metro_cities: initialMetro,
    notification_email: settings.notificationEmail,
    job_boards: resolveJobBoards(settings.jobBoards),
    daily_enrich_quota: settings.dailyEnrichQuota ?? 25,
    min_score_for_enrich: settings.minScoreForEnrich ?? 60,
    min_score_for_phone: settings.minScoreForPhone ?? 75,
  });
  const [profiles, setProfiles] = useState(initialProfiles);
  const [emailPrefs, setEmailPrefs] = useState<EmailReportPreferences>(() =>
    normalizeEmailReportPreferences(settings.emailReportPreferences),
  );
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const cityOptions = useMemo(
    () => getCitiesForState(form.focus_state),
    [form.focus_state],
  );
  const metroOptions = useMemo(
    () => getMetroCitiesForState(form.focus_state),
    [form.focus_state],
  );
  const countyOptions = useMemo(
    () => getCountiesForState(form.focus_state),
    [form.focus_state],
  );

  async function saveSettings() {
    if (form.job_boards.length === 0) {
      setMessage("Select at least one job board.");
      return;
    }
    setSaving(true);
    const res = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    setMessage(res.ok ? "Settings saved." : "Failed to save.");
    router.refresh();
  }

  async function triggerRun() {
    const res = await fetch("/api/admin/trigger-run", { method: "POST" });
    const data = await res.json();
    setMessage(data.message || (res.ok ? "Run requested." : "Failed."));
  }

  async function toggleProfile(id: string, isActive: boolean) {
    await fetch("/api/admin/search-profiles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, is_active: isActive }),
    });
    setProfiles((p) =>
      p.map((x) => (x.id === id ? { ...x, isActive } : x)),
    );
  }

  async function updateProfileDistance(id: string, raw: string) {
    const linkedin_distance =
      raw.trim() === "" ? null : Math.max(1, parseInt(raw, 10) || 25);
    await fetch("/api/admin/search-profiles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, linkedin_distance }),
    });
    setProfiles((p) =>
      p.map((x) =>
        x.id === id ? { ...x, linkedinDistance: linkedin_distance } : x,
      ),
    );
  }

  async function saveEmailPreferences() {
    setSaving(true);
    const res = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email_report_preferences: emailPrefs }),
    });
    setSaving(false);
    setMessage(res.ok ? "Email report preferences saved." : "Failed to save.");
    router.refresh();
  }

  function toggleJobBoard(id: JobBoardId) {
    setForm((prev) => {
      const selected = prev.job_boards.includes(id)
        ? prev.job_boards.filter((b) => b !== id)
        : [...prev.job_boards, id];
      return { ...prev, job_boards: selected };
    });
  }

  async function logout() {
    await fetch("/api/admin/login", { method: "DELETE" });
    router.push("/admin/login");
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin</h1>
        <button onClick={logout} className="text-sm text-gray-500 hover:underline">
          Log out
        </button>
      </div>

      {message && (
        <p className="text-sm bg-blue-50 dark:bg-blue-950 text-blue-800 dark:text-blue-200 px-3 py-2 rounded-lg">
          {message}
        </p>
      )}

      <section className="border border-amber-200 dark:border-amber-900 rounded-xl p-5 space-y-3 bg-amber-50/50 dark:bg-amber-950/20">
        <h2 className="font-semibold text-lg">Worker Mac setup</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Scrapes and enrichment credits run on a separate Mac via{" "}
          <code className="text-xs">worker/.env</code> — not stored in this
          admin UI. On a fresh install, copy{" "}
          <code className="text-xs">worker/.env.example</code> →{" "}
          <code className="text-xs">worker/.env</code>, set CRM/API keys, then
          run <code className="text-xs">./scripts/install_launchd.sh</code>.
        </p>
        <div className="text-sm text-gray-700 dark:text-gray-300 space-y-2">
          <p className="font-medium">LinkedIn hiring team (optional)</p>
          <p className="text-gray-600 dark:text-gray-400">
            Public job pages only expose a &quot;job poster&quot; on ~5–10% of
            listings. &quot;Meet the hiring team&quot; requires a logged-in
            session on the worker. To enable on a{" "}
            <strong>burner LinkedIn account only</strong> (never your primary):
          </p>
          <pre className="text-xs bg-white dark:bg-gray-950 border border-amber-200 dark:border-amber-900 rounded-lg p-3 overflow-x-auto">
{`# worker/.env
LINKEDIN_LI_AT_ENABLED=true
LINKEDIN_LI_AT=<li_at cookie from browser DevTools>`}
          </pre>
          <p className="text-xs text-amber-800 dark:text-amber-200">
            Pilot with{" "}
            <code className="text-xs">python scripts/backfill_linkedin_posters.py</code>{" "}
            on 5 jobs before enabling twice-daily scrapes — automated auth
            fetches risk account bans. Decision-maker outreach still flows
            through Apollo → ContactOut by company; posters are a bonus signal.
          </p>
        </div>
      </section>

      <section className="border rounded-xl p-5 space-y-4 dark:border-gray-800">
        <h2 className="font-semibold text-lg">Geographic focus</h2>
        <p className="text-sm text-gray-500">
          Select one or more cities or counties to geofence your daily searches.
        </p>
        <label className="block text-sm">
          Scope
          <select
            value={form.geographic_scope}
            onChange={(e) =>
              setForm({
                ...form,
                geographic_scope: e.target.value as GeographicScope,
              })
            }
            className="mt-1 w-full border rounded-lg px-3 py-2 dark:bg-gray-900 dark:border-gray-700"
          >
            {SCOPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        {form.geographic_scope !== "national" && (
          <label className="block text-sm">
            State
            <select
              value={form.focus_state}
              onChange={(e) =>
                setForm({
                  ...form,
                  focus_state: e.target.value,
                  focus_cities: [],
                  focus_counties: [],
                })
              }
              className="mt-1 w-full border rounded-lg px-3 py-2 dark:bg-gray-900 dark:border-gray-700"
            >
              {US_STATES.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </label>
        )}

        {form.geographic_scope === "city" && (
          <>
            <MultiSelect
              label="Cities (select all that apply)"
              options={cityOptions}
              selected={form.focus_cities}
              onChange={(focus_cities) => setForm({ ...form, focus_cities })}
              emptyHint="City dropdowns are available for Florida. Add more states in locations.ts as you expand."
            />
            <MultiSelect
              label="Metro expansion cities (accept jobs in these cities when focus is WPB)"
              options={metroOptions}
              selected={form.metro_cities}
              onChange={(metro_cities) => setForm({ ...form, metro_cities })}
              emptyHint="Metro list available for Florida WPB market."
            />
            <p className="text-xs text-gray-500">
              Also matches: {DEFAULT_WPB_METRO_ALIASES.join(", ")}
            </p>
          </>
        )}

        {form.geographic_scope === "county" && (
          <MultiSelect
            label="Counties (select all that apply)"
            options={countyOptions}
            selected={form.focus_counties}
            onChange={(focus_counties) => setForm({ ...form, focus_counties })}
            emptyHint="County dropdowns are available for Florida."
          />
        )}

        <label className="block text-sm">
          Daily report email
          <input
            type="email"
            value={form.notification_email}
            onChange={(e) => setForm({ ...form, notification_email: e.target.value })}
            className="mt-1 w-full border rounded-lg px-3 py-2 dark:bg-gray-900 dark:border-gray-700"
          />
        </label>

        <button
          onClick={saveSettings}
          disabled={saving}
          className="bg-gray-900 text-white dark:bg-white dark:text-gray-900 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
      </section>

      <section className="border rounded-xl p-5 space-y-4 dark:border-gray-800">
        <h2 className="font-semibold text-lg">Enrichment quotas</h2>
        <p className="text-sm text-gray-500">
          Control how many companies get enriched per night. Scraping and scoring
          are free; enrichment credits scale with the daily quota.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-sm">
            Daily enrich quota (N)
            <input
              type="number"
              min={1}
              max={100}
              value={form.daily_enrich_quota}
              onChange={(e) =>
                setForm({
                  ...form,
                  daily_enrich_quota: Number(e.target.value) || 25,
                })
              }
              className="mt-1 w-full border rounded-lg px-3 py-2 dark:bg-gray-900 dark:border-gray-700"
            />
          </label>
          <label className="block text-sm">
            Min score to enrich
            <input
              type="number"
              min={0}
              max={100}
              value={form.min_score_for_enrich}
              onChange={(e) =>
                setForm({
                  ...form,
                  min_score_for_enrich: Number(e.target.value) || 60,
                })
              }
              className="mt-1 w-full border rounded-lg px-3 py-2 dark:bg-gray-900 dark:border-gray-700"
            />
          </label>
          <label className="block text-sm">
            Min score for phone reveal
            <input
              type="number"
              min={0}
              max={100}
              value={form.min_score_for_phone}
              onChange={(e) =>
                setForm({
                  ...form,
                  min_score_for_phone: Number(e.target.value) || 75,
                })
              }
              className="mt-1 w-full border rounded-lg px-3 py-2 dark:bg-gray-900 dark:border-gray-700"
            />
          </label>
        </div>
        <button
          onClick={saveSettings}
          disabled={saving}
          className="bg-gray-900 text-white dark:bg-white dark:text-gray-900 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save quotas"}
        </button>
      </section>

      <section className="border rounded-xl p-5 space-y-4 dark:border-gray-800">
        <h2 className="font-semibold text-lg">Job boards</h2>
        <p className="text-sm text-gray-500">
          Sources scraped at 6 AM and 6 PM ET (via JobSpy on your worker Mac).
          Toggle boards to A/B which sources produce net-new companies — no
          deploy needed.
        </p>
        <ul className="space-y-2">
          {JOB_BOARD_OPTIONS.map((board) => (
            <li
              key={board.id}
              className="flex items-start gap-3 text-sm border rounded-lg px-3 py-2 dark:border-gray-800"
            >
              <input
                id={`board-${board.id}`}
                type="checkbox"
                className="mt-1"
                checked={form.job_boards.includes(board.id)}
                onChange={() => toggleJobBoard(board.id)}
              />
              <label htmlFor={`board-${board.id}`} className="cursor-pointer">
                <span className="font-medium">{board.label}</span>
                <span className="block text-xs text-gray-500 mt-0.5">
                  {board.description}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <button
          onClick={saveSettings}
          disabled={saving}
          className="bg-gray-900 text-white dark:bg-white dark:text-gray-900 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save job boards"}
        </button>
      </section>

      <section className="border rounded-xl p-5 space-y-3 dark:border-gray-800">
        <h2 className="font-semibold text-lg">Job title searches</h2>
        <p className="text-sm text-gray-500">
          Active searches run in your selected geographic area and job boards during
          the 6 AM / 6 PM scrape. LinkedIn radius (miles) is per title — tight for
          supply-rich searches, blank for wide (scarce titles like Head of Talent).
        </p>
        <ul className="space-y-2">
          {profiles.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-3 text-sm border rounded-lg px-3 py-2 dark:border-gray-800"
            >
              <span className="font-medium">{p.name}</span>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-gray-500">
                  LI radius (mi)
                  <input
                    type="number"
                    min={1}
                    max={100}
                    placeholder="wide"
                    className="w-16 border rounded px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                    value={p.linkedinDistance ?? ""}
                    onChange={(e) =>
                      setProfiles((rows) =>
                        rows.map((x) =>
                          x.id === p.id
                            ? {
                                ...x,
                                linkedinDistance:
                                  e.target.value === ""
                                    ? null
                                    : parseInt(e.target.value, 10) || null,
                              }
                            : x,
                        ),
                      )
                    }
                    onBlur={(e) => updateProfileDistance(p.id, e.target.value)}
                  />
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={p.isActive}
                    onChange={(e) => toggleProfile(p.id, e.target.checked)}
                  />
                  Active
                </label>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="border rounded-xl p-5 space-y-3 dark:border-gray-800">
        <h2 className="font-semibold text-lg">Daily email — backlog filters</h2>
        <p className="text-sm text-gray-500">
          Filters apply to the ranked backlog (top 500) section in your daily report.
          Leave unchecked for all. Call sheet leads are unchanged.
        </p>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={emailPrefs.includeBacklogSection !== false}
            onChange={(e) =>
              setEmailPrefs((p) => ({
                ...p,
                includeBacklogSection: e.target.checked,
              }))
            }
          />
          Include filtered backlog section in daily email
        </label>

        <MultiSelect
          label="Job titles (email backlog)"
          options={filterOptions.jobTitles}
          selected={emailPrefs.jobTitleFilters ?? []}
          onChange={(jobTitleFilters) =>
            setEmailPrefs((p) => ({ ...p, jobTitleFilters }))
          }
          emptyHint="Run a scrape to populate job title options."
        />

        <MultiSelect
          label="Industries (email backlog)"
          options={filterOptions.industries}
          selected={emailPrefs.industryFilters ?? []}
          onChange={(industryFilters) =>
            setEmailPrefs((p) => ({ ...p, industryFilters }))
          }
          emptyHint="Industries appear after domain enrichment."
        />

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-medium">Salary filter</span>
          <select
            value={emailPrefs.salaryFilter ?? "any"}
            onChange={(e) =>
              setEmailPrefs((p) => ({
                ...p,
                salaryFilter: e.target.value as EmailReportPreferences["salaryFilter"],
              }))
            }
            className="border rounded-md px-2 py-1 dark:border-gray-700 dark:bg-gray-900"
          >
            <option value="any">Any</option>
            <option value="has_salary">Has salary posted</option>
            <option value="min_salary">Minimum salary</option>
          </select>
          {(emailPrefs.salaryFilter ?? "any") === "min_salary" && (
            <input
              type="number"
              min={0}
              step={5000}
              value={emailPrefs.salaryMinUsd ?? 80000}
              onChange={(e) =>
                setEmailPrefs((p) => ({
                  ...p,
                  salaryMinUsd: parseInt(e.target.value, 10) || 0,
                }))
              }
              className="w-28 border rounded-md px-2 py-1 dark:border-gray-700 dark:bg-gray-900"
            />
          )}
          <label className="flex items-center gap-2">
            Max backlog rows
            <input
              type="number"
              min={1}
              max={100}
              value={emailPrefs.backlogLeadLimit ?? 25}
              onChange={(e) =>
                setEmailPrefs((p) => ({
                  ...p,
                  backlogLeadLimit: parseInt(e.target.value, 10) || 25,
                }))
              }
              className="w-16 border rounded-md px-2 py-1 dark:border-gray-700 dark:bg-gray-900"
            />
          </label>
        </div>

        <button
          onClick={saveEmailPreferences}
          disabled={saving}
          className="bg-gray-900 text-white dark:bg-white dark:text-gray-900 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save email preferences"}
        </button>
      </section>

      <section className="border rounded-xl p-5 space-y-3 dark:border-gray-800">
        <h2 className="font-semibold text-lg">Run pipeline</h2>
        <p className="text-sm text-gray-500">
          Trigger a scrape + enrich from your phone or browser. Your home Mac worker
          polls every 5 minutes and runs when requested. Only the top-N ranked backlog
          companies are enriched (not all net-new).
        </p>
        <button
          onClick={triggerRun}
          className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800"
        >
          Run now
        </button>
        {settings.lastRunAt && (
          <p className="text-xs text-gray-400">
            Last run: {new Date(settings.lastRunAt).toLocaleString()}
          </p>
        )}
      </section>

      <section className="border rounded-xl p-5 text-sm text-gray-600 dark:text-gray-400 dark:border-gray-800">
        <h2 className="font-semibold text-lg text-gray-900 dark:text-gray-100 mb-2">
          Why a home Mac?
        </h2>
        <p>
          Job boards block cloud servers (Vercel/AWS). Scraping must run on a home
          Mac with a residential IP. Vercel hosts the CRM and admin; your Mac runs
          the Python worker. Use <strong>Run now</strong> from your iPhone browser
          or set up an iOS Shortcut to open the admin page.
        </p>
      </section>
    </div>
  );
}
