"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  EnrollmentEvent,
  OutreachMessage,
  SequenceEnrollment,
} from "@/lib/db/schema";
import { api, Badge, btn, btnPrimary, input, statusTone, Section } from "./shared";

type Row = {
  enrollment: SequenceEnrollment;
  contactName: string;
  contactTitle: string | null;
  companyName: string;
};

export function EnrollmentsTab() {
  const [rows, setRows] = useState<Row[]>([]);
  const [detail, setDetail] = useState<{
    enrollment: SequenceEnrollment;
    messages: OutreachMessage[];
    events: EnrollmentEvent[];
  } | null>(null);
  const [contactId, setContactId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await api<{ enrollments: Row[] }>("/api/admin/outreach/enrollments");
    setRows(data.enrollments);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, [load]);

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/admin/outreach/enrollments", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await load();
      if (detail) await openDetail(detail.enrollment.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (id: string) => {
    const data = await api<{
      enrollment: SequenceEnrollment;
      messages: OutreachMessage[];
      events: EnrollmentEvent[];
    }>(`/api/admin/outreach/enrollments?id=${id}`);
    setDetail(data);
  };

  return (
    <div className="space-y-4">
      <Section
        title="Manually enroll a contact"
        subtitle="Same eligibility rules as auto-enroll (verified email, company status new, ICP, no prior enrollment). Drafting is transactional — all steps pass the sanitizer or nothing is created."
      >
        <div className="flex gap-2">
          <input
            className={input}
            placeholder="Contact UUID (from the company page)"
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
          />
          <button
            className={btnPrimary}
            disabled={busy || !contactId.trim()}
            onClick={() => act({ action: "enroll", contactId: contactId.trim() })}
          >
            Enroll
          </button>
        </div>
        {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      </Section>

      <Section title={`Enrollments (${rows.length})`}>
        {rows.length === 0 ? (
          <p className="text-sm text-gray-400">No enrollments yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[44rem]">
              <thead>
                <tr className="text-left text-[10px] font-medium uppercase tracking-wide text-gray-500 border-b border-gray-200 dark:border-gray-800">
                  <th className="py-2 pr-3">Contact</th>
                  <th className="py-2 pr-3">Company</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Channels</th>
                  <th className="py-2 pr-3">Timezone</th>
                  <th className="py-2 pr-3">Next step</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ enrollment, contactName, contactTitle, companyName }) => (
                  <tr
                    key={enrollment.id}
                    className="border-b border-gray-100 dark:border-gray-900 last:border-b-0 align-top"
                  >
                    <td className="py-2 pr-3">
                      <button
                        className="text-left hover:underline"
                        onClick={() => openDetail(enrollment.id)}
                      >
                        <span className="font-medium">{contactName}</span>
                        {contactTitle && (
                          <span className="block text-xs text-gray-500">{contactTitle}</span>
                        )}
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-gray-600 dark:text-gray-400">{companyName}</td>
                    <td className="py-2 pr-3">
                      <Badge tone={statusTone(enrollment.status)}>{enrollment.status}</Badge>
                      {enrollment.stopReason && (
                        <span className="block text-[10px] text-gray-400 max-w-[12rem]">
                          {enrollment.stopReason}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {enrollment.phoneNumber ? "email + text" : "email only"}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      {enrollment.timezone}
                      <button
                        className="block text-[10px] text-blue-600 hover:underline"
                        onClick={() => {
                          const tz = prompt(
                            "IANA timezone override (empty to keep):",
                            enrollment.timezone,
                          );
                          if (tz) act({ action: "set_timezone", enrollmentId: enrollment.id, timezone: tz });
                        }}
                      >
                        override
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-xs text-gray-500">
                      {enrollment.nextStepAt
                        ? new Date(enrollment.nextStepAt).toLocaleString()
                        : "—"}
                    </td>
                    <td className="py-2">
                      <div className="flex gap-1.5">
                        {enrollment.status === "active" ? (
                          <button
                            className={btn}
                            disabled={busy}
                            onClick={() => act({ action: "pause", enrollmentId: enrollment.id })}
                          >
                            Pause
                          </button>
                        ) : ["paused", "waiting_on_manual"].includes(enrollment.status) ? (
                          <button
                            className={btn}
                            disabled={busy}
                            onClick={() => act({ action: "resume", enrollmentId: enrollment.id })}
                          >
                            Resume
                          </button>
                        ) : null}
                        {["active", "paused", "waiting_on_manual"].includes(enrollment.status) && (
                          <button
                            className={btn}
                            disabled={busy}
                            onClick={() => act({ action: "stop", enrollmentId: enrollment.id })}
                          >
                            Stop
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {detail && (
        <Section
          title={`Enrollment detail — ${detail.enrollment.id.slice(0, 8)}`}
          subtitle={`Flow node: ${detail.enrollment.currentNodeId ?? "(not started)"} · pinned version ${detail.enrollment.flowVersionId?.slice(0, 8) ?? "—"}`}
        >
          <button className={`${btn} mb-3`} onClick={() => setDetail(null)}>
            Close
          </button>
          {detail.enrollment.status === "waiting_on_manual" && (
            <div className="mb-3 flex gap-2">
              <button
                className={btnPrimary}
                onClick={() => act({ action: "resolve_manual", enrollmentId: detail.enrollment.id, edge: "done" })}
              >
                Mark handled (continue flow)
              </button>
            </div>
          )}
          <h3 className="text-sm font-medium mb-1">Messages</h3>
          <div className="space-y-2 mb-4">
            {detail.messages.map((message) => (
              <div key={message.id} className="border border-gray-200 dark:border-gray-800 rounded-lg p-2 text-xs">
                <div className="flex gap-2 items-center">
                  <Badge tone={statusTone(message.status)}>{message.status}</Badge>
                  <Badge tone="blue">{message.stepKind}</Badge>
                  <Badge>{message.channel}</Badge>
                  {message.sentAt && <span>sent {new Date(message.sentAt).toLocaleString()}</span>}
                  {message.scheduledFor && !message.sentAt && (
                    <span>scheduled {new Date(message.scheduledFor).toLocaleString()}</span>
                  )}
                </div>
                {message.subject && <p className="font-medium mt-1">{message.subject}</p>}
                <pre className="whitespace-pre-wrap font-sans mt-1 max-h-32 overflow-y-auto text-gray-600 dark:text-gray-400">
                  {message.body}
                </pre>
              </div>
            ))}
          </div>
          <h3 className="text-sm font-medium mb-1">Audit trail (enrollment_events)</h3>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {detail.events.map((event) => (
              <p key={event.id} className="text-[11px] font-mono text-gray-500">
                {new Date(event.createdAt).toLocaleString()} · {event.eventType} ·{" "}
                {event.actor} · {JSON.stringify(event.payload)}
              </p>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
