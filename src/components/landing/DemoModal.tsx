"use client";

import { useEffect, useId, useRef, useState } from "react";
import { CRM_URL, DEMO_EMAIL } from "./constants";

type DemoModalProps = {
  open: boolean;
  onClose: () => void;
  interests?: string[];
};

function DemoModalForm({
  onClose,
  interests,
}: {
  onClose: () => void;
  interests: string[];
}) {
  const titleId = useId();
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = window.setTimeout(() => firstFieldRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [onClose]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries()) as Record<
      string,
      string
    >;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ...data, interests }),
      });
      if (!res.ok) throw new Error("relay failed");
      setSent(true);
    } catch {
      const body = encodeURIComponent(
        `Name: ${data.name}\nCompany: ${data.company || ""}\nEmail: ${data.email}\nPhone: ${data.phone || ""}\nInterested in: ${interests.length ? interests.join(", ") : "(general demo)"}\n\n${data.message || ""}`,
      );
      window.location.href = `mailto:${DEMO_EMAIL}?subject=${encodeURIComponent("New demo request — Villatoro platform")}&body=${body}`;
      setSubmitting(false);
      setError("Could not send automatically — opening your email client.");
    }
  }

  return (
    <div
      className="landing-modal-bg open"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="landing-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <button type="button" className="close" onClick={onClose} aria-label="Close">
          ×
        </button>

        {!sent ? (
          <div>
            <h3 id={titleId}>Book a demo</h3>
            <div className="sub">
              20 minutes. We&apos;ll tune it to your markets live on the call.
              {interests.length > 0 ? (
                <>
                  <br />
                  Focus: {interests.join(", ")}
                </>
              ) : null}
            </div>
            <form onSubmit={onSubmit}>
              <label htmlFor="f-name">Name</label>
              <input
                ref={firstFieldRef}
                id="f-name"
                name="name"
                required
                placeholder="Jane Smith"
                autoComplete="name"
              />
              <label htmlFor="f-company">Company</label>
              <input
                id="f-company"
                name="company"
                placeholder="Smith Recruiting Group"
                autoComplete="organization"
              />
              <label htmlFor="f-email">Work email</label>
              <input
                id="f-email"
                name="email"
                type="email"
                required
                placeholder="jane@company.com"
                autoComplete="email"
              />
              <label htmlFor="f-phone">Phone</label>
              <input
                id="f-phone"
                name="phone"
                type="tel"
                placeholder="(561) 555-0100"
                autoComplete="tel"
              />
              <label htmlFor="f-msg">What are you hoping to solve?</label>
              <textarea
                id="f-msg"
                name="message"
                placeholder="Markets, niches, current prospecting process…"
                defaultValue={
                  interests.length
                    ? `Interested in: ${interests.join(", ")}`
                    : undefined
                }
              />
              {error ? (
                <p style={{ marginTop: 12, fontSize: 12.5, color: "#ff8f6b" }}>{error}</p>
              ) : null}
              <div className="actions">
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? "Sending…" : "Request demo"}
                </button>
                <button type="button" className="btn btn-ghost" onClick={onClose}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div className="sent visible">
            <div className="check" aria-hidden="true">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#5ee0a8"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
            <h3>Request sent</h3>
            <div className="sub" style={{ marginTop: 6 }}>
              We&apos;ll reach out within one business day.
              <br />
              In the meantime,{" "}
              <a href={CRM_URL} style={{ color: "#6c8bff" }}>
                try the platform free →
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function DemoModal({ open, onClose, interests = [] }: DemoModalProps) {
  if (!open) return null;
  return <DemoModalForm onClose={onClose} interests={interests} />;
}
