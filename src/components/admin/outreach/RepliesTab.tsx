"use client";

import { useCallback, useEffect, useState } from "react";
import type { InboundMessage, OutreachNotification } from "@/lib/db/schema";
import { api, Badge, btn, statusTone, Section } from "./shared";

type NotificationRow = {
  notification: OutreachNotification;
  contactName: string | null;
  companyName: string | null;
};

function intentTone(intent: string | null): string {
  if (!intent) return "gray";
  if (intent.startsWith("positive")) return "green";
  if (["negative", "opt_out", "data_deletion", "bounce_hard", "complaint"].includes(intent))
    return "red";
  if (["ooo", "courtesy", "unknown", "bounce_soft"].includes(intent)) return "amber";
  return "blue";
}

export function RepliesTab() {
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [inbound, setInbound] = useState<InboundMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ notifications: NotificationRow[]; inbound: InboundMessage[] }>(
      "/api/admin/outreach/notifications",
    );
    setNotifications(data.notifications);
    setInbound(data.inbound);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, [load]);

  const markRead = async (ids: string[]) => {
    await api("/api/admin/outreach/notifications", {
      method: "PATCH",
      body: JSON.stringify({ ids }),
    });
    await load();
  };

  const unread = notifications.filter((n) => !n.notification.readAt);

  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-red-600">{error}</p>}
      <Section
        title={`Notifications (${unread.length} unread)`}
        subtitle="Positive and info-request replies fire an email alert immediately; everything lands here."
      >
        {unread.length > 0 && (
          <button
            className={`${btn} mb-3`}
            onClick={() => markRead(unread.map((n) => n.notification.id))}
          >
            Mark all read
          </button>
        )}
        {notifications.length === 0 ? (
          <p className="text-sm text-gray-400">No reply notifications yet.</p>
        ) : (
          <div className="space-y-2">
            {notifications.map(({ notification, contactName, companyName }) => (
              <div
                key={notification.id}
                className={`border rounded-lg p-2.5 text-sm ${
                  notification.readAt
                    ? "border-gray-100 dark:border-gray-900 opacity-70"
                    : "border-amber-300 dark:border-amber-800"
                }`}
              >
                <div className="flex flex-wrap gap-2 items-center">
                  <Badge tone={intentTone(notification.intent)}>{notification.intent}</Badge>
                  <span className="font-medium">{contactName ?? "Unknown contact"}</span>
                  {companyName && <span className="text-gray-500">@ {companyName}</span>}
                  <span className="text-[11px] text-gray-400">
                    {new Date(notification.createdAt).toLocaleString()}
                  </span>
                  {!notification.readAt && (
                    <button className={btn} onClick={() => markRead([notification.id])}>
                      Mark read
                    </button>
                  )}
                </div>
                {notification.snippet && (
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                    {notification.snippet}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Inbound messages"
        subtitle="Email + text replies in one pipeline — classified intent and the rule action taken."
      >
        {inbound.length === 0 ? (
          <p className="text-sm text-gray-400">Nothing inbound yet.</p>
        ) : (
          <div className="space-y-2">
            {inbound.map((message) => (
              <div
                key={message.id}
                className="border border-gray-200 dark:border-gray-800 rounded-lg p-2.5"
              >
                <div className="flex flex-wrap gap-2 items-center text-xs">
                  <Badge>{message.channel}</Badge>
                  <Badge tone={intentTone(message.classifiedIntent)}>
                    {message.classifiedIntent ?? "unclassified"}
                    {message.confidence != null && ` (${(message.confidence * 100).toFixed(0)}%)`}
                  </Badge>
                  <span className="text-gray-500">{message.fromAddress}</span>
                  <span className="text-gray-400">
                    {new Date(message.receivedAt).toLocaleString()}
                  </span>
                  {message.enrollmentId ? (
                    <Badge tone="green">matched</Badge>
                  ) : (
                    <Badge tone={statusTone("failed")}>no enrollment match</Badge>
                  )}
                </div>
                {message.subject && (
                  <p className="text-xs font-medium mt-1">{message.subject}</p>
                )}
                <pre className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap font-sans mt-1 max-h-28 overflow-y-auto">
                  {message.rawBody.slice(0, 800)}
                </pre>
                {message.actionTaken && (
                  <p className="text-[11px] text-sky-700 dark:text-sky-400 mt-1">
                    Action: {message.actionTaken}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
