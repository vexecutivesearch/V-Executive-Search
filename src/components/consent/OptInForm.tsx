"use client";

import { useState } from "react";
import type { DisclosureCopy } from "@/lib/consent/disclosure";

/**
 * E-SIGN compliant opt-in form.
 *
 * Three properties are load-bearing and must not be "improved" away:
 *  - the consent checkbox ships unchecked (no defaultChecked)
 *  - it is not `required`, so consent is never a condition of submitting
 *  - the disclosure is rendered from server-resolved copy and only its version
 *    tag is posted back, so the stored artifact is wording we can reproduce
 */

type FieldErrors = Record<string, string>;

const FIELD_CLASS =
  "mt-1 block w-full rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm";

export function OptInForm({
  disclosure,
  sourceTag,
}: {
  disclosure: DisclosureCopy;
  /** `src` from the link, e.g. `call:<companyId>` — attribution only. */
  sourceTag?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setErrors({});
    setFailure(null);
    const form = new FormData(event.currentTarget);
    try {
      const res = await fetch("/api/consent/opt-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(form.entries())),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        errors?: FieldErrors;
        error?: string;
      };
      if (res.ok && data.ok) {
        setDone(true);
        return;
      }
      if (data.errors) setErrors(data.errors);
      else setFailure(data.error ?? "Something went wrong. Please try again.");
    } catch {
      setFailure("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-xl border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 p-5">
        <h2 className="font-semibold text-emerald-900 dark:text-emerald-100">
          Thanks — we have your details.
        </h2>
        <p className="mt-1 text-sm text-emerald-900/80 dark:text-emerald-200/80">
          A recruiter will be in touch shortly about the role you are hiring for.
        </p>
      </div>
    );
  }

  const fieldError = (name: string) =>
    errors[name] ? (
      <span className="mt-1 block text-xs text-red-700 dark:text-red-400">
        {errors[name]}
      </span>
    ) : null;

  return (
    <form
      method="POST"
      action="/api/consent/opt-in"
      onSubmit={handleSubmit}
      className="space-y-4"
    >
      <input
        type="hidden"
        name="disclosure_version"
        value={disclosure.version}
      />
      {sourceTag && <input type="hidden" name="src" value={sourceTag} />}

      <label className="block text-sm font-medium">
        Company name
        <input
          name="company_name"
          type="text"
          required
          autoComplete="organization"
          className={FIELD_CLASS}
        />
        {fieldError("companyName")}
      </label>

      <label className="block text-sm font-medium">
        Your name
        <input
          name="contact_name"
          type="text"
          required
          autoComplete="name"
          className={FIELD_CLASS}
        />
        {fieldError("contactName")}
      </label>

      <label className="block text-sm font-medium">
        Work email
        <input
          name="work_email"
          type="email"
          required
          autoComplete="email"
          className={FIELD_CLASS}
        />
        {fieldError("workEmail")}
      </label>

      <label className="block text-sm font-medium">
        Phone
        <input
          name="phone"
          type="tel"
          required
          autoComplete="tel"
          className={FIELD_CLASS}
        />
        {fieldError("phone")}
      </label>

      <label className="block text-sm font-medium">
        What are you hiring for?
        <textarea
          name="hiring_for"
          required
          rows={3}
          placeholder="e.g. two paralegals and an office manager in Fort Lauderdale"
          className={FIELD_CLASS}
        />
        {fieldError("hiringFor")}
      </label>

      <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/60 p-3">
        <label className="flex gap-3 text-xs leading-relaxed text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            name="sms_consent"
            value="on"
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-400"
          />
          <span>
            {disclosure.text}
          </span>
        </label>
        {fieldError("disclosureVersion")}
        <p className="mt-2 pl-7 text-xs text-gray-500">
          <a href={disclosure.privacyUrl} className="underline">
            Privacy Policy
          </a>
          {" · "}
          <a href={disclosure.termsUrl} className="underline">
            Terms of Service
          </a>
        </p>
      </div>

      <p className="text-xs text-gray-500">
        Ticking the box is optional. Leave it unticked and we will only email or
        call you.
      </p>

      {failure && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {failure}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-gray-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
      >
        {busy ? "Sending…" : "Send my hiring brief"}
      </button>
    </form>
  );
}
