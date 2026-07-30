"use client";

import { useCallback, useEffect, useState } from "react";
import type { OutreachTemplate } from "@/lib/db/schema";
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
      <Section
        title="Add a winning email/text"
        subtitle="Paste real messages that got replies. They become style exemplars for the LLM — treated as data, never instructions."
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
                  {k}
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
          Add template
        </button>
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      </Section>

      <Section title={`Template bank (${templates.length})`}>
        <div className="space-y-3">
          {templates.map((t) => (
            <div key={t.id} className="border border-gray-200 dark:border-gray-800 rounded-lg p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="blue">{t.kind}</Badge>
                <Badge>{t.channel}</Badge>
                <span className="text-sm font-medium">{t.name}</span>
                <Badge tone={t.isActive ? "green" : "gray"}>
                  {t.isActive ? "active" : "inactive"}
                </Badge>
                {t.flaggedAt && <Badge tone="red">⚠ {t.flagReason}</Badge>}
                <span className="text-[11px] text-gray-400">
                  used {t.timesUsed} · replies {t.timesReplied} · positive {t.timesPositive} ·
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
