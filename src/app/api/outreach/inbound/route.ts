import { NextRequest, NextResponse } from "next/server";
import { unauthorized, verifyWorkerAuth } from "@/lib/auth";
import { ingestInboundMessage } from "@/lib/outreach/inbound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Worker-posted inbound messages: IMAP poll of the Reply-To mailbox and
 * chat.db scans both land here (channel-tagged) and flow through the same
 * classifier + rule engine. Idempotent on external_id.
 */
export async function POST(request: NextRequest) {
  if (!verifyWorkerAuth(request)) return unauthorized();

  let payload: {
    messages?: Array<{
      channel: "email" | "imessage";
      from?: string;
      subject?: string;
      body: string;
      external_id?: string;
      in_reply_to?: string;
      received_at?: string;
    }>;
  };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const results = [];
  for (const message of payload.messages ?? []) {
    if (!message.body?.trim() || !["email", "imessage"].includes(message.channel)) {
      continue;
    }
    try {
      const result = await ingestInboundMessage({
        channel: message.channel,
        fromAddress: message.from ?? null,
        subject: message.subject ?? null,
        body: message.body,
        externalId: message.external_id ?? null,
        inReplyTo: message.in_reply_to ?? null,
        receivedAt: message.received_at ? new Date(message.received_at) : undefined,
      });
      results.push({
        external_id: message.external_id,
        duplicate: result.duplicate,
        matched: result.matched,
        intent: result.intent,
        action: result.actionTaken,
      });
    } catch (error) {
      console.error("[outreach] inbound ingest failed", error);
      results.push({ external_id: message.external_id, error: String(error) });
    }
  }

  return NextResponse.json({ ok: true, results });
}
