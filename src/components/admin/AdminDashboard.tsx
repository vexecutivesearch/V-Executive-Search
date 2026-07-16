"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  GeographicScope,
  PipelineSettings,
  SearchProfile,
} from "@/lib/db/schema";
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
import { SUGGESTED_FOCUS_KEYWORDS } from "@/lib/scrape-keyword-suggestions";
import {
  DEFAULT_STATE_GEO_CONFIGS,
  findStateGeoConfig,
  getDefaultGeoSelection,
  normalizeGeoToken,
  type StateGeoConfig,
} from "@/lib/state-geo-config";

const SCOPES: { value: GeographicScope; label: string }[] = [
  { value: "national", label: "National (United States)" },
  { value: "state", label: "State" },
  { value: "city", label: "City" },
  { value: "county", label: "County" },
];

type MultiSelectOption = {
  value: string;
  disabled?: boolean;
};

function toMultiSelectOptions(
  values: string[],
  available?: ReadonlySet<string>,
): MultiSelectOption[] {
  if (!available) {
    return values.map((value) => ({ value }));
  }
  const availableNorm = new Set(
    [...available].map((value) => normalizeGeoToken(value)),
  );
  return values.map((value) => ({
    value,
    disabled: !availableNorm.has(normalizeGeoToken(value)),
  }));
}

function mergeSelectedIntoOptions(
  options: MultiSelectOption[],
  selected: string[],
): MultiSelectOption[] {
  const seen = new Set(options.map((option) => normalizeGeoToken(option.value)));
  const extras = selected
    .filter((value) => !seen.has(normalizeGeoToken(value)))
    .map((value) => ({ value, disabled: true }));
  return [...options, ...extras];
}

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  emptyHint,
}: {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  emptyHint?: string;
}) {
  const displayOptions = mergeSelectedIntoOptions(options, selected);

  function toggle(value: string, disabled?: boolean) {
    const isSelected = selected.includes(value);
    // Allow clearing stale selections even when the option is unavailable.
    if (disabled && !isSelected) return;
    onChange(
      isSelected
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
      {displayOptions.length === 0 ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
          {emptyHint ?? "No predefined locations for this state yet."}
        </p>
      ) : (
        <div className="mt-2 max-h-48 overflow-y-auto border rounded-lg p-2 space-y-1 dark:border-gray-700">
          {displayOptions.map((option) => (
            <label
              key={option.value}
              className={`flex items-center gap-2 px-2 py-1 rounded ${
                option.disabled
                  ? "cursor-not-allowed opacity-45 text-gray-400 dark:text-gray-500"
                  : "hover:bg-gray-50 dark:hover:bg-gray-900 cursor-pointer"
              }`}
            >
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                disabled={option.disabled && !selected.includes(option.value)}
                onChange={() => toggle(option.value, option.disabled)}
              />
              <span>
                {option.value}
                {option.disabled ? " (unavailable)" : ""}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function listEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const normalized = new Set(a.map(normalizeGeoToken));
  return b.every((value) => normalized.has(normalizeGeoToken(value)));
}

function titleCaseGeoKey(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function AdminDashboard({
  settings,
  profiles: initialProfiles,
  filterOptions,
  geoConfigs = DEFAULT_STATE_GEO_CONFIGS,
}: {
  settings: PipelineSettings;
  profiles: SearchProfile[];
  filterOptions: TodayFilterOptions;
  geoConfigs?: StateGeoConfig[];
}) {
  const router = useRouter();
  const initialState = settings.focusState ?? "Florida";
  const initialDefaults = getDefaultGeoSelection(initialState, null, geoConfigs);
  const initialCities =
    settings.focusCities?.length
      ? settings.focusCities
      : settings.focusCity
        ? [settings.focusCity]
        : initialDefaults.focusCities;
  const initialCounties =
    settings.focusCounties?.length
      ? settings.focusCounties
      : settings.focusCounty
        ? [settings.focusCounty]
        : initialDefaults.focusCounties;

  const initialMetro =
    settings.metroCities?.length
      ? settings.metroCities
      : initialDefaults.metroCities;
  const initialAliases =
    settings.metroAliases?.length
      ? settings.metroAliases
      : initialDefaults.metroAliases;

  const [form, setForm] = useState({
    geographic_scope: settings.geographicScope,
    focus_state: initialState,
    focus_cities: initialCities,
    focus_counties: initialCounties,
    metro_cities: initialMetro,
    metro_aliases: initialAliases,
    notification_email: settings.notificationEmail,
    job_boards: resolveJobBoards(settings.jobBoards),
    daily_enrich_quota: settings.dailyEnrichQuota ?? 25,
    min_score_for_enrich: settings.minScoreForEnrich ?? 60,
    min_score_for_phone: settings.minScoreForPhone ?? 75,
    contact_titles: (settings.contactTitles?.length
      ? settings.contactTitles
      : [
          "HR Director",
          "VP People",
          "Head of Talent",
        ]
    ).join("\n"),
  });
  const [profiles, setProfiles] = useState(initialProfiles);
  const [customKeyword, setCustomKeyword] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [addingKeyword, setAddingKeyword] = useState(false);
  const [emailPrefs, setEmailPrefs] = useState<EmailReportPreferences>(() =>
    normalizeEmailReportPreferences(settings.emailReportPreferences),
  );
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const workerPayload = settings.workerStatusPayload ?? {};
  const workerReleaseSha =
    typeof workerPayload.worker_release_sha === "string"
      ? workerPayload.worker_release_sha
      : null;
  const workerReleaseRef =
    typeof workerPayload.worker_release_ref === "string"
      ? workerPayload.worker_release_ref
      : "origin/worker-production";
  const workerCommitMatchesRelease =
    Boolean(workerReleaseSha) &&
    Boolean(settings.workerCommitSha) &&
    workerReleaseSha === settings.workerCommitSha;
  const workerDriftReasons = [
    !settings.workerCommitSha ? "unknown SHA" : null,
    settings.workerDirty ? "dirty worktree" : null,
    settings.workerBranch &&
    workerReleaseRef.startsWith("origin/") &&
    settings.workerBranch !== workerReleaseRef.replace(/^origin\//, "") &&
    !(settings.workerBranch === "HEAD" && workerCommitMatchesRelease)
      ? `branch ${settings.workerBranch}`
      : null,
    workerReleaseSha &&
    settings.workerCommitSha &&
    workerReleaseSha !== settings.workerCommitSha
      ? `not at ${workerReleaseRef}`
      : null,
  ].filter(Boolean);

  const cityOptions = useMemo(
    () => getCitiesForState(form.focus_state, geoConfigs),
    [form.focus_state, geoConfigs],
  );
  const metroOptions = useMemo(
    () => getMetroCitiesForState(form.focus_state, geoConfigs),
    [form.focus_state, geoConfigs],
  );
  const countyOptions = useMemo(
    () => getCountiesForState(form.focus_state, geoConfigs),
    [form.focus_state, geoConfigs],
  );
  const configuredStateNames = useMemo(
    () =>
      new Set(
        geoConfigs.map((config) => config.stateName).filter(Boolean),
      ),
    [geoConfigs],
  );
  const stateIsConfigured = useMemo(
    () => Boolean(findStateGeoConfig(form.focus_state, geoConfigs)),
    [form.focus_state, geoConfigs],
  );
  const activeGeoConfig = useMemo(
    () => findStateGeoConfig(form.focus_state, geoConfigs),
    [form.focus_state, geoConfigs],
  );
  const marketOptions = useMemo(
    () =>
      Object.entries(activeGeoConfig?.metroPresets ?? {}).map(
        ([key, preset]) => ({
          key,
          label: preset.marketName ?? titleCaseGeoKey(key),
        }),
      ),
    [activeGeoConfig],
  );
  const selectedMarketKey = useMemo(() => {
    if (!activeGeoConfig) return "";
    const match = Object.entries(activeGeoConfig.metroPresets).find(
      ([, preset]) =>
        listEquals(form.metro_cities, preset.metroCities ?? []) &&
        listEquals(form.focus_counties, preset.focusCounties ?? []),
    );
    return match?.[0] ?? "";
  }, [activeGeoConfig, form.focus_counties, form.metro_cities]);
  const selectedMarketPreset = useMemo(() => {
    if (!activeGeoConfig || !selectedMarketKey) return null;
    return activeGeoConfig.metroPresets[selectedMarketKey] ?? null;
  }, [activeGeoConfig, selectedMarketKey]);
  const availableCityValues = useMemo(() => {
    if (form.geographic_scope !== "city" || !selectedMarketPreset) {
      return new Set(cityOptions);
    }
    return new Set(selectedMarketPreset.metroCities ?? []);
  }, [cityOptions, form.geographic_scope, selectedMarketPreset]);
  const availableMetroValues = useMemo(() => {
    if (form.geographic_scope !== "city" || !selectedMarketPreset) {
      return new Set(metroOptions);
    }
    return new Set(selectedMarketPreset.metroCities ?? []);
  }, [form.geographic_scope, metroOptions, selectedMarketPreset]);
  const availableCountyValues = useMemo(() => {
    if (form.geographic_scope === "city" && selectedMarketPreset) {
      return new Set(selectedMarketPreset.focusCounties ?? []);
    }
    return new Set(countyOptions);
  }, [countyOptions, form.geographic_scope, selectedMarketPreset]);

  function applyStateDefaults(state: string) {
    if (!findStateGeoConfig(state, geoConfigs)) return;
    const defaults = getDefaultGeoSelection(state, null, geoConfigs);
    setForm((prev) => ({
      ...prev,
      focus_state: state,
      focus_cities: defaults.focusCities,
      focus_counties: defaults.focusCounties,
      metro_cities: defaults.metroCities,
      metro_aliases: defaults.metroAliases,
    }));
  }

  function applyMarketPreset(marketKey: string) {
    const preset = activeGeoConfig?.metroPresets[marketKey];
    if (!preset) return;
    setForm((prev) => ({
      ...prev,
      focus_cities: preset.metroCities[0] ? [preset.metroCities[0]] : [],
      focus_counties: preset.focusCounties,
      metro_cities: preset.metroCities,
      metro_aliases: preset.metroAliases,
    }));
  }

  function applyFocusCities(focus_cities: string[]) {
    if (!focus_cities.length) {
      const defaults = getDefaultGeoSelection(form.focus_state, null, geoConfigs);
      setForm({
        ...form,
        focus_cities: defaults.focusCities,
        focus_counties: defaults.focusCounties,
        metro_cities: defaults.metroCities,
        metro_aliases: defaults.metroAliases,
      });
      return;
    }

    const primaryCity = focus_cities[0];
    const defaults = getDefaultGeoSelection(
      form.focus_state,
      primaryCity,
      geoConfigs,
    );
    setForm({
      ...form,
      focus_cities,
      focus_counties: defaults.focusCounties,
      metro_cities: defaults.metroCities,
      metro_aliases: defaults.metroAliases,
    });
  }

  async function saveSettings() {
    if (form.job_boards.length === 0) {
      setMessage("Select at least one job board.");
      return;
    }
    setSaving(true);
    const contact_titles = form.contact_titles
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
    const res = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, contact_titles }),
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

  function profileTermKey(term: string) {
    return term.trim().toLowerCase() || " ";
  }

  async function addFocusKeyword(name: string, searchTerm: string) {
    const term = searchTerm.trim().toLowerCase().replace(/\s+/g, " ");
    if (!term) {
      setMessage("Enter a keyword to scrape.");
      return;
    }
    if (profiles.some((p) => profileTermKey(p.searchTerm) === term)) {
      setMessage(`Keyword “${term}” is already in your scrape list.`);
      return;
    }
    setAddingKeyword(true);
    const res = await fetch("/api/admin/search-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim() || term,
        search_term: term,
        is_active: true,
        results_wanted: 50,
        hours_old: 168,
        linkedin_distance: 25,
      }),
    });
    setAddingKeyword(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setMessage(data.error || "Failed to add keyword.");
      return;
    }
    const data = (await res.json()) as { profile: SearchProfile };
    setProfiles((p) => [...p, data.profile]);
    setCustomKeyword("");
    setCustomLabel("");
    setMessage(`Added scrape keyword “${term}” (runs on all active boards).`);
    router.refresh();
  }

  const broadProfiles = useMemo(
    () =>
      profiles.filter((p) => {
        const term = profileTermKey(p.searchTerm);
        return (
          term === " " ||
          [
            "manager",
            "director",
            "coordinator",
            "specialist",
            "assistant",
            "analyst",
            "sales",
          ].includes(term)
        );
      }),
    [profiles],
  );

  const focusProfiles = useMemo(
    () =>
      profiles.filter(
        (p) => !broadProfiles.some((b) => b.id === p.id),
      ),
    [profiles, broadProfiles],
  );

  const missingSuggestions = useMemo(() => {
    const have = new Set(profiles.map((p) => profileTermKey(p.searchTerm)));
    return SUGGESTED_FOCUS_KEYWORDS.filter(
      (s) => !have.has(s.searchTerm.trim().toLowerCase()),
    );
  }, [profiles]);

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
          <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-white/70 dark:bg-gray-950/40 p-3 space-y-1">
            <p className="font-medium">Worker code status</p>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Last heartbeat:{" "}
              {settings.workerLastSeenAt
                ? new Date(settings.workerLastSeenAt).toLocaleString()
                : "never"}
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Running SHA:{" "}
              <code className="text-[11px]">
                {settings.workerCommitSha ?? "unknown"}
              </code>
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              Branch: {settings.workerBranch ?? "unknown"} · Dirty:{" "}
              {settings.workerDirty ? "yes" : "no"}
            </p>
            {settings.workerAgentSummary && (
              <p className="text-xs text-gray-600 dark:text-gray-400">
                Agents: {settings.workerAgentSummary}
              </p>
            )}
            {workerReleaseSha && (
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {workerReleaseRef}:{" "}
                <code className="text-[11px]">{workerReleaseSha}</code>
              </p>
            )}
            <p
              className={`text-xs font-medium ${
                workerDriftReasons.length
                  ? "text-red-700 dark:text-red-300"
                  : "text-green-700 dark:text-green-300"
              }`}
            >
              {workerDriftReasons.length
                ? `Drift alarm: ${workerDriftReasons.join(", ")}`
                : `Worker SHA matches ${workerReleaseRef} and worktree is clean.`}
            </p>
          </div>
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
          Only seeded markets are selectable. Other U.S. states, cities, and
          counties stay visible but greyed out until geo coverage is added.
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
              onChange={(e) => applyStateDefaults(e.target.value)}
              className="mt-1 w-full border rounded-lg px-3 py-2 dark:bg-gray-900 dark:border-gray-700"
            >
              {US_STATES.map((state) => {
                const available = configuredStateNames.has(state);
                return (
                  <option key={state} value={state} disabled={!available}>
                    {available ? state : `${state} (unavailable)`}
                  </option>
                );
              })}
            </select>
            {!stateIsConfigured && (
              <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">
                This state has no geo config yet. Pick a configured state to
                continue.
              </span>
            )}
          </label>
        )}

        {form.geographic_scope === "city" && marketOptions.length > 0 && (
          <label className="block text-sm">
            Market
            <select
              value={selectedMarketKey}
              onChange={(e) => applyMarketPreset(e.target.value)}
              className="mt-1 w-full border rounded-lg px-3 py-2 dark:bg-gray-900 dark:border-gray-700"
            >
              <option value="" disabled>
                Custom selection
              </option>
              {marketOptions.map((market) => (
                <option key={market.key} value={market.key}>
                  {market.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-gray-500">
              Switching markets fully reloads focus cities, counties, scrape hubs,
              and aliases for one active market. Cities and counties outside the
              selected market are greyed out.
            </span>
          </label>
        )}

        {form.geographic_scope === "city" && (
          <>
            <MultiSelect
              label="Cities (select all that apply)"
              options={toMultiSelectOptions(cityOptions, availableCityValues)}
              selected={form.focus_cities}
              onChange={applyFocusCities}
              emptyHint={
                stateIsConfigured
                  ? "No city presets are configured for this state yet."
                  : "Select a configured state to load city presets."
              }
            />
            <MultiSelect
              label="Metro expansion cities (nearby scrape hubs + accept in ICP)"
              options={toMultiSelectOptions(metroOptions, availableMetroValues)}
              selected={form.metro_cities}
              onChange={(metro_cities) => setForm({ ...form, metro_cities })}
              emptyHint={
                stateIsConfigured
                  ? "No metro expansion presets are configured for this state yet."
                  : "Select a configured state to load metro hubs."
              }
            />
            <p className="text-xs text-gray-500">
              Focus cities scrape first; metro cities are added as nearby hubs
              (capped). Also matches:{" "}
              {(form.metro_aliases.length
                ? form.metro_aliases
                : activeGeoConfig?.defaultMetroAliases ?? []
              ).join(", ") || "—"}
            </p>
          </>
        )}

        {form.geographic_scope === "county" && (
          <MultiSelect
            label="Counties (select all that apply)"
            options={toMultiSelectOptions(countyOptions, availableCountyValues)}
            selected={form.focus_counties}
            onChange={(focus_counties) => setForm({ ...form, focus_counties })}
            emptyHint={
              stateIsConfigured
                ? "No county presets are configured for this state yet."
                : "Select a configured state to load county presets."
            }
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
          disabled={saving || (form.geographic_scope !== "national" && !stateIsConfigured)}
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
        <h2 className="font-semibold text-lg">Contact titles (enrichment)</h2>
        <p className="text-sm text-gray-500">
          People to find at companies that are hiring — used by Apollo/ContactOut,
          not as job-board search queries. One title per line.
        </p>
        <textarea
          rows={8}
          className="w-full border rounded-lg px-3 py-2 text-sm font-mono dark:border-gray-700 dark:bg-gray-900"
          value={form.contact_titles}
          onChange={(e) =>
            setForm((f) => ({ ...f, contact_titles: e.target.value }))
          }
        />
        <button
          onClick={saveSettings}
          disabled={saving}
          className="bg-gray-900 text-white dark:bg-white dark:text-gray-900 px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save contact titles"}
        </button>
      </section>

      <section className="border rounded-xl p-5 space-y-4 dark:border-gray-800">
        <div>
          <h2 className="font-semibold text-lg">Daily scrape queries</h2>
          <p className="text-sm text-gray-500 mt-1">
            Additive <strong>OR</strong> queries across Indeed, LinkedIn, Google
            Jobs (SerpAPI), and other active boards. Broad buckets stay on —
            focus keywords run <em>on top</em> of them. Turning a keyword off
            never removes Market scan.
          </p>
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Broad market (always keep these for hiring-signal coverage)
          </h3>
          <ul className="space-y-2">
            {broadProfiles.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 text-sm border rounded-lg px-3 py-2 dark:border-gray-800"
              >
                <span className="font-medium">
                  {p.name}
                  <span className="ml-2 text-xs font-normal text-gray-500">
                    ({p.searchTerm.trim() || "all roles"})
                  </span>
                </span>
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
                      onBlur={(e) =>
                        updateProfileDistance(p.id, e.target.value)
                      }
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
        </div>

        <div className="space-y-2 border-t pt-4 dark:border-gray-800">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Focus keywords (Legal · Marketing · Construction · HR · Finance)
          </h3>
          <p className="text-xs text-gray-500">
            Each active keyword is scraped daily in your geo. White-label ready —
            enable suggestions or add custom terms below.
          </p>

          {missingSuggestions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {missingSuggestions.map((s) => (
                <button
                  key={s.searchTerm}
                  type="button"
                  disabled={addingKeyword}
                  onClick={() => addFocusKeyword(s.name, s.searchTerm)}
                  className="text-xs px-2.5 py-1 rounded-full border border-dashed border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-900 disabled:opacity-50"
                  title={`Add “${s.searchTerm}” scrape (${s.family})`}
                >
                  + {s.name}
                </button>
              ))}
            </div>
          )}

          <ul className="space-y-2">
            {focusProfiles.length === 0 ? (
              <li className="text-sm text-gray-400">
                No focus keywords yet — click a suggestion above or add a custom
                keyword.
              </li>
            ) : (
              focusProfiles.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-3 text-sm border rounded-lg px-3 py-2 dark:border-gray-800"
                >
                  <span className="font-medium">
                    {p.name}
                    <span className="ml-2 text-xs font-normal text-gray-500">
                      query: “{p.searchTerm.trim()}”
                    </span>
                  </span>
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
                        onBlur={(e) =>
                          updateProfileDistance(p.id, e.target.value)
                        }
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
              ))
            )}
          </ul>

          <div className="flex flex-wrap items-end gap-2 pt-2">
            <label className="text-sm">
              <span className="text-xs text-gray-500 block mb-1">
                Custom keyword
              </span>
              <input
                type="text"
                value={customKeyword}
                onChange={(e) => setCustomKeyword(e.target.value)}
                placeholder="e.g. bookkeeper"
                className="border rounded-lg px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 min-w-[10rem]"
              />
            </label>
            <label className="text-sm">
              <span className="text-xs text-gray-500 block mb-1">
                Label (optional)
              </span>
              <input
                type="text"
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                placeholder="Display name"
                className="border rounded-lg px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900 min-w-[10rem]"
              />
            </label>
            <button
              type="button"
              disabled={addingKeyword || !customKeyword.trim()}
              onClick={() =>
                addFocusKeyword(
                  customLabel.trim() || customKeyword.trim(),
                  customKeyword.trim(),
                )
              }
              className="bg-gray-900 text-white dark:bg-white dark:text-gray-900 px-4 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50"
            >
              {addingKeyword ? "Adding…" : "Add keyword"}
            </button>
          </div>
        </div>
      </section>

      <section className="border rounded-xl p-5 space-y-3 dark:border-gray-800">
        <h2 className="font-semibold text-lg">Daily email — Hot Listings</h2>
        <p className="text-sm text-gray-500">
          On by default for 6 AM and 6 PM sends. Uses the same Hot Listings filter
          as the Today tab (mid-size, role families, geo, exclusions).
        </p>

        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={emailPrefs.includeHotListingsSection !== false}
            onChange={(e) =>
              setEmailPrefs((p) => ({
                ...p,
                includeHotListingsSection: e.target.checked,
              }))
            }
          />
          Include Hot Listings section in daily email
        </label>

        {emailPrefs.includeHotListingsSection !== false && (
          <label className="block text-sm">
            <span className="text-gray-500">Max hot listings in email</span>
            <input
              type="number"
              min={1}
              max={50}
              value={emailPrefs.hotListingsLimit ?? 15}
              onChange={(e) =>
                setEmailPrefs((p) => ({
                  ...p,
                  hotListingsLimit: parseInt(e.target.value, 10) || 15,
                }))
              }
              className="mt-1 block w-28 text-sm border border-gray-200 dark:border-gray-700 rounded-md px-2 py-1.5 bg-white dark:bg-gray-900"
            />
          </label>
        )}
      </section>

      <section className="border rounded-xl p-5 space-y-3 dark:border-gray-800">
        <h2 className="font-semibold text-lg">Daily email — backlog section</h2>
        <p className="text-sm text-gray-500">
          Optional. When off, the daily email is call-sheet only (recommended until
          filters are tuned). When on, a short ranked-backlog preview is appended.
        </p>

        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={emailPrefs.includeBacklogSection === true}
            onChange={(e) =>
              setEmailPrefs((p) => ({
                ...p,
                includeBacklogSection: e.target.checked,
              }))
            }
          />
          Include ranked backlog section in daily email
        </label>

        {emailPrefs.includeBacklogSection === true ? (
          <div className="space-y-3 pt-2 border-t dark:border-gray-800">
            <p className="text-xs text-gray-500">
              Leave scan bucket/sector unchecked for all. Filters refine the
              backlog preview only — they do not change the CRM Today view.
            </p>

            <MultiSelect
              label="Market scan buckets"
              options={filterOptions.jobTitles}
              selected={emailPrefs.jobTitleFilters ?? []}
              onChange={(jobTitleFilters) =>
                setEmailPrefs((p) => ({ ...p, jobTitleFilters }))
              }
              emptyHint="Add market scan queries above first."
            />

            {filterOptions.dataAvailability.industryFilterReady ? (
              <>
                <MultiSelect
                  label="Sectors (rolled up from company industry)"
                  options={filterOptions.industries}
                  selected={emailPrefs.industryFilters ?? []}
                  onChange={(industryFilters) =>
                    setEmailPrefs((p) => ({ ...p, industryFilters }))
                  }
                  emptyHint="No industries in the database yet."
                />
                {(filterOptions.otherIndustryLabels?.length ?? 0) > 0 ? (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    Other ({filterOptions.otherIndustryLabels.length}):{" "}
                    {filterOptions.otherIndustryLabels.join(", ")}. Add these to{" "}
                    <code className="text-[11px]">src/lib/industry-sectors.ts</code>.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-xs text-gray-500">
                Sector filter locked until backlog industry fill ≥ 40% (currently{" "}
                {filterOptions.dataAvailability.industryPct}%).
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">Salary filter</span>
              {filterOptions.dataAvailability.salaryFilterReady ? (
                <>
                  <select
                    value={emailPrefs.salaryFilter ?? "any"}
                    onChange={(e) =>
                      setEmailPrefs((p) => ({
                        ...p,
                        salaryFilter: e.target
                          .value as EmailReportPreferences["salaryFilter"],
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
                </>
              ) : (
                <span className="text-gray-500">
                  Hidden until salary fill ≥ 40% (currently{" "}
                  {filterOptions.dataAvailability.salaryAnyPct}%)
                </span>
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
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            Backlog email section is off. Enable above only when you want a filtered
            preview in the morning email.
          </p>
        )}

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
          Trigger a scrape-only/jobs-only ingest from your phone or browser. Your
          home Mac worker polls every 5 minutes and runs when requested. Paid
          Apollo/ContactOut enrichment stays manual per company.
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
