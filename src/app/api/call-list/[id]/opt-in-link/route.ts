import { NextRequest, NextResponse } from "next/server";
import { sendOptInLink } from "@/lib/calls/send-opt-in-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Email the consent form to the prospect. This is what the call is for: no
 * consent is captured on the phone, only a form click is earned.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: {
    contact_id?: string | null;
    email?: string | null;
    sent_by?: string | null;
    call_outcome_id?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = await sendOptInLink({
    entryId: id,
    contactId: body.contact_id ?? null,
    email: body.email ?? null,
    sentBy: body.sent_by ?? null,
    callOutcomeId: body.call_outcome_id ?? null,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, send: result.send ?? null },
      { status: result.status },
    );
  }
  return NextResponse.json({ send: result.send });
}
