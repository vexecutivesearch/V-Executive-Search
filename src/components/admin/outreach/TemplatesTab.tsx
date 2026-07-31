"use client";

import { useCallback, useEffect, useState } from "react";
import type { OutreachTemplate } from "@/lib/db/schema";
import {
  PROVEN_BADGE_LABEL,
  templateChannelLabel,
  templateKindLabel,
} from "@/lib/outreach/template-labels";
import { api, Badge, btn, btnPrimary, input, label, Section } from "./shared";

const KINDS = [
  "intro",
  "followup_1",
  "followup_2",
  "text_1",
  "text_2",
  "text_3",
  "reply_positive",
  "reply_info_request",
  "reply_decline",
  "booking_confirmation",
];

export function TemplatesTab() {
  const [templates, setTemplates] = useState<OutreachTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", kind: "intro", subject: "", body: "" });
  const [editing, setEditing] = useState<OutreachTemplate | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ templates: OutreachTemplate[] }>(
      "/api/admin/outreach/templates",
    );
    setTemplates(data.templates);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, [load]);

  const create = async () => {
    try {
      await api("/api/admin/outreach/templates", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name,
          kind: draft.kind,
          channel: draft.kind.startsWith("text") ? "imessage" : "email",
          exampleSubject: draft.subject || undefined,
          exampleBody: draft.body,
        }),
      });
      setDraft({ name: "", kind: "intro", subject: "", body: "" });
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    try {
      await api("/api/admin/outreach/templates", {
        method: "PATCH",
        body: JSON.stringify({ id, ...body }),
      });
      setEditing(null);
      await load();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/40 px-4 py-3 text-sm text-sky-950 dark:text-sky-100">
        <p className="font-semibold">How templates work (important)</p>
        <ul className="mt-1.5 list-disc pl-5 text-xs space-y-1 text-sky-900/90 dark:text-sky-100/90">
          <li>
            These are <strong>style exemplars</strong> for Claude, not fill in the blank
            mail merge and <strong>not what gets sent</strong>.
          </li>
          <li>
            When you Add to Call List on a job listing, Claude reads 1–2 active exemplars
            for that step, plus the real company / role facts, and writes a{" "}
            <strong>new</strong> email or SMS in that voice.
          </li>
          <li>
            Hardcoded names like &quot;Stacy&quot; or &quot;Plus Power&quot; in an exemplar
            are from a winning past send. Claude must not copy those facts; it personalizes
            off the selected listing.
          </li>
          <li>
            Reply kinds (<code>reply_positive</code>, <code>reply_info_request</code>,{" "}
            <code>reply_decline</code>) are also read by the classifier: when someone under
            enrollment replies, Claude matches their message to these so the right next email
            goes out (not a guess).
          </li>
          <li>
            Naming: <em>&quot;medium and step, what it says&quot;</em>, for example{" "}
            <strong>Intro email, boutique firm pitch</strong>. Never put the step kind,
            the channel or the provenance in the name; those are real fields and show as
            the badges on each row.
          </li>
          <li>
            A <strong>{PROVEN_BADGE_LABEL}</strong> badge means the exemplar is a real
            message Alejandro actually sent that actually got a reply. Without it, the
            exemplar was written in that voice so the step kind has coverage.
          </li>
          <li>
            House style: <strong>no dashes or hyphens</strong> in exemplars or outbound
            copy (sanitizer rejects them).
          </li>
        </ul>
      </div>

      <Section
        title="Add a winning email/text (style exemplar)"
        subtitle="Paste a real message that got a reply. Claude uses it as few shot voice DNA only. Do not use {{tokens}}, dashes, or hyphens."
      >
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className={label}>Name</label>
            <input
              className={input}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div>
            <label className={label}>Step kind</label>
            <select
              className={input}
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {templateKindLabel(k)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Subject (emails)</label>
            <input
              className={input}
              value={draft.subject}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            />
          </div>
        </div>
        <div className="mt-3">
          <label className={label}>Body</label>
          <textarea
            className={`${input} h-40 font-mono text-xs`}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
        </div>
        <button
          className={`${btnPrimary} mt-2`}
          disabled={!draft.name.trim() || !draft.body.trim()}
          onClick={create}
        >
          Add exemplar
        </button>
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      </Section>

      <Section
        title={`Style exemplar bank (${templates.length})`}
        subtitle="Shown to Claude as few shot examples when drafting. Outbound messages are always freshly written for the selected job listing."
      >
        <div className="space-y-3">
          {templates.map((t) => (
            <div key={t.id} className="border border-gray-200 dark:border-gray-800 rounded-lg p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="blue">{templateKindLabel(t.kind)}</Badge>
                <Badge>{templateChannelLabel(t.channel)}</Badge>
                <Badge tone="gray">exemplar · not sent as is</Badge>
                <span className="text-sm font-medium">{t.name}</span>
                {t.isProven && <Badge tone="green">{PROVEN_BADGE_LABEL}</Badge>}
                <Badge tone={t.isActive ? "green" : "gray"}>
                  {t.isActive ? "active" : "inactive"}
                </Badge>
                {t.flaggedAt && <Badge tone="red">⚠ {t.flagReason}</Badge>}
                <span className="text-[11px] text-gray-400">
                  sent {t.timesUsed} · replied {t.timesReplied} · positive {t.timesPositive} ·
                  opt-out {t.timesOptOut}
                </span>
              </div>
              {editing?.id === t.id ? (
                <div className="mt-2 space-y-2">
                  {t.channel === "email" && (
                    <input
                      className={input}
                      defaultValue={editing.exampleSubject ?? ""}
                      onChange={(e) =>
                        setEditing({ ...editing, exampleSubject: e.target.value })
                      }
                    />
                  )}
                  <textarea
                    className={`${input} h-40 font-mono text-xs`}
                    defaultValue={editing.exampleBody}
                    onChange={(e) => setEditing({ ...editing, exampleBody: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <button
                      className={btnPrimary}
                      onClick={() =>
                        patch(t.id, {
                          exampleSubject: editing.exampleSubject,
                          exampleBody: editing.exampleBody,
                        })
                      }
                    >
                      Save
                    </button>
                    <button className={btn} onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {t.exampleSubject && (
                    <p className="text-xs font-medium mt-1.5">Subject: {t.exampleSubject}</p>
                  )}
                  <pre className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap font-sans mt-1 max-h-28 overflow-y-auto">
                    {t.exampleBody}
                  </pre>
                  <div className="flex gap-2 mt-2">
                    <button className={btn} onClick={() => setEditing(t)}>
                      Edit
                    </button>
                    <button
                      className={btn}
                      onClick={() => patch(t.id, { isActive: !t.isActive })}
                    >
                      {t.isActive ? "Deactivate" : "Activate"}
                    </button>
                    {t.flaggedAt && (
                      <button className={btn} onClick={() => patch(t.id, { clearFlag: true })}>
                        Clear flag
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
