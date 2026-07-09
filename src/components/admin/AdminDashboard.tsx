"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { GeographicScope, PipelineSettings, SearchProfile } from "@/lib/db/schema";
import {
  getCitiesForState,
  getCountiesForState,
  US_STATES,
} from "@/lib/locations";

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
}: {
  settings: PipelineSettings;
  profiles: SearchProfile[];
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

  const [form, setForm] = useState({
    geographic_scope: settings.geographicScope,
    focus_state: settings.focusState ?? "Florida",
    focus_cities: initialCities,
    focus_counties: initialCounties,
    notification_email: settings.notificationEmail,
  });
  const [profiles, setProfiles] = useState(initialProfiles);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const cityOptions = useMemo(
    () => getCitiesForState(form.focus_state),
    [form.focus_state],
  );
  const countyOptions = useMemo(
    () => getCountiesForState(form.focus_state),
    [form.focus_state],
  );

  async function saveSettings() {
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

  async function triggerContactOut() {
    const res = await fetch("/api/admin/trigger-contactout", { method: "POST" });
    const data = await res.json();
    setMessage(data.message || (res.ok ? "ContactOut sync requested." : "Failed."));
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
          <MultiSelect
            label="Cities (select all that apply)"
            options={cityOptions}
            selected={form.focus_cities}
            onChange={(focus_cities) => setForm({ ...form, focus_cities })}
            emptyHint="City dropdowns are available for Florida. Add more states in locations.ts as you expand."
          />
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

      <section className="border rounded-xl p-5 space-y-3 dark:border-gray-800">
        <h2 className="font-semibold text-lg">Job title searches</h2>
        <p className="text-sm text-gray-500">
          Active searches run in your selected geographic area at 6 AM and 6 PM daily.
        </p>
        <ul className="space-y-2">
          {profiles.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between text-sm border rounded-lg px-3 py-2 dark:border-gray-800"
            >
              <span className="font-medium">{p.name}</span>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={p.isActive}
                  onChange={(e) => toggleProfile(p.id, e.target.checked)}
                />
                Active
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="border rounded-xl p-5 space-y-3 dark:border-gray-800">
        <h2 className="font-semibold text-lg">Run pipeline</h2>
        <p className="text-sm text-gray-500">
          Trigger a scrape from your phone or browser. Your home Mac worker polls
          every 5 minutes and runs when requested.
        </p>
        <button
          onClick={triggerRun}
          className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-800"
        >
          Run now
        </button>
        <button
          onClick={triggerContactOut}
          className="bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-800 ml-2"
        >
          Sync ContactOut phones
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
