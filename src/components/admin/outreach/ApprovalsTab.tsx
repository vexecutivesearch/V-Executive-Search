"use client";

import { useCallback, useEffect, useState } from "react";
import type { OutreachMessage } from "@/lib/db/schema";
import { api, Badge, btn, btnPrimary, statusTone, Section } from "./shared";

type Row = {
  message: OutreachMessage;
  contactName: string;
  companyName: string;
  enrollmentStatus: string;
  emailAddress: string | null;
  phoneNumber: string | null;
};

export function ApprovalsTab() {
  const [rows, setRows] = useState<Row[]>([]);
  const [pendingOnly, setPendingOnly] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ messages: Row[] }>(
      `/api/admin/outreach/messages${pendingOnly ? "?pending=1" : ""}`,
    );
    setRows(data.messages);
  }, [pendingOnly]);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, [load]);

  const act = async (ids: string[], action: string) => {
    setBusy(action);
    setError(null);
    try {
      await api("/api/admin/outreach/messages", {
        method: "PATCH",
        body: JSON.stringify({ ids, action }),
      });
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const pendingIds = rows
    .filter((r) => !r.message.approvedAt && ["drafted", "queued"].includes(r.message.status))
    .map((r) => r.message.id);

  return (
    <Section
      title="Message approvals"
      subtitle="Preview every drafted message before it can send. With the approval gate on, nothing dispatches without a green check."
    >
      <div className="flex items-center gap-2 mb-3">
        <button className={btn} onClick={() => setPendingOnly(!pendingOnly)}>
          {pendingOnly ? "Showing: pending approval" : "Showing: all messages"}
        </button>
        {pendingIds.length > 0 && (
          <button
            className={btnPrimary}
            disabled={busy !== null}
            onClick={() => act(pendingIds, "approve")}
          >
            Approve all pending ({pendingIds.length})
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
      {rows.length === 0 ? (
        <p className="text-sm text-gray-400">
          Nothing here — enroll a contact (Enrollments tab) and drafts will appear for review.
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map(({ message, contactName, companyName, emailAddress, phoneNumber }) => (
            <div
              key={message.id}
              className="border border-gray-200 dark:border-gray-800 rounded-lg p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={statusTone(message.status)}>{message.status}</Badge>
                <Badge tone="blue">{message.stepKind}</Badge>
                <Badge>{message.channel}</Badge>
                <span className="font-medium">{contactName}</span>
                <span className="text-gray-500">@ {companyName}</span>
                <span className="text-gray-400">
                  → {message.channel === "email" ? emailAddress : phoneNumber}
                </span>
                {message.scheduledFor && (
                  <span className="text-gray-400">
                    scheduled {new Date(message.scheduledFor).toLocaleString()}
                  </span>
                )}
                {message.approvedAt ? (
                  <Badge tone="green">approved</Badge>
                ) : (
                  <Badge tone="amber">needs approval</Badge>
                )}
                {message.deferredReason && (
                  <Badge tone="red">{message.deferredReason}</Badge>
                )}
              </div>
              {message.subject && (
                <p className="text-sm font-medium mt-2">Subject: {message.subject}</p>
              )}
              <pre className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap font-sans mt-1 max-h-48 overflow-y-auto">
                {message.body}
              </pre>
              {message.error && (
                <p className="text-xs text-red-600 mt-1">Error: {message.error}</p>
              )}
              {["drafted", "queued"].includes(message.status) && (
                <div className="flex gap-2 mt-2">
                  {message.approvedAt ? (
                    <button
                      className={btn}
                      disabled={busy !== null}
                      onClick={() => act([message.id], "unapprove")}
                    >
                      Un-approve
                    </button>
                  ) : (
                    <button
                      className={btnPrimary}
                      disabled={busy !== null}
                      onClick={() => act([message.id], "approve")}
                    >
                      Approve
                    </button>
                  )}
                  <button
                    className={btn}
                    disabled={busy !== null}
                    onClick={() => act([message.id], "redraft")}
                  >
                    Redraft (LLM)
                  </button>
                  <button
                    className={btn}
                    disabled={busy !== null}
                    onClick={() => act([message.id], "cancel")}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
