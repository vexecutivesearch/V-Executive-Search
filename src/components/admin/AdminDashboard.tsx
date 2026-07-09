"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PipelineSettings, SearchProfile } from "@/lib/db/schema";

const SCOPES = [
  { value: "national", label: "National (United States)" },
  { value: "state", label: "State" },
  { value: "city", label: "City" },
  { value: "county", label: "County" },
];

export function AdminDashboard({
  settings,
  profiles: initialProfiles,
}: {
  settings: PipelineSettings;
  profiles: SearchProfile[];
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    geographic_scope: settings.geographicScope,
    focus_state: settings.focusState ?? "Florida",
    focus_city: settings.focusCity ?? "",
    focus_county: settings.focusCounty ?? "",
    notification_email: settings.notificationEmail,
  });
  const [profiles, setProfiles] = useState(initialProfiles);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

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
        <label className="block text-sm">
          Scope
          <select
            value={form.geographic_scope}
            onChange={(e) =>
              setForm({ ...form, geographic_scope: e.target.value as typeof form.geographic_scope })
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
            <input
              value={form.focus_state}
              onChange={(e) => setForm({ ...form, focus_state: e.target.value })}
              placeholder="Florida"
              className="mt-1 w-full border rounded-lg px-3 py-2 dark:bg-gray-900 dark:border-gray-700"
            />
          </label>
        )}

        {form.geographic_scope === "city" && (
          <label className="block text-sm">
            City
            <input
              value={form.focus_city}
              onChange={(e) => setForm({ ...form, focus_city: e.target.value })}
              placeholder="Miami"
              className="mt-1 w-full border rounded-lg px-3 py-2 dark:bg-gray-900 dark:border-gray-700"
            />
          </label>
        )}

        {form.geographic_scope === "county" && (
          <label className="block text-sm">
            County
            <input
              value={form.focus_county}
              onChange={(e) => setForm({ ...form, focus_county: e.target.value })}
              placeholder="Miami-Dade"
              className="mt-1 w-full border rounded-lg px-3 py-2 dark:bg-gray-900 dark:border-gray-700"
            />
          </label>
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
          Active searches run in your selected geographic area each morning.
        </p>
        <ul className="space-y-2">
          {profiles.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between text-sm border rounded-lg px-3 py-2 dark:border-gray-800"
            >
              <span>
                {p.name} — <code className="text-xs">{p.searchTerm}</code>
              </span>
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
