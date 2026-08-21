import { NextRequest, NextResponse } from "next/server";
import { CONSENT_DISCLOSURE_VERSION } from "@/lib/consent/disclosure";
import {
  landInboundLead,
  parseInboundLeadSubmission,
} from "@/lib/consent/inbound-lead";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Self-hosted opt-in endpoint — the consented inbound lane.
 *
 * Accepts the form on /opt-in as JSON or as a plain form post (so the page
 * still works without JavaScript). Writes the consent artifact, matches or
 * creates the company, creates the contact, sets lead_source, and marks the
 * company for review. It does NOT enroll a sequence: this pass only lands the
 * lead with its consent intact.
 *
 * A Meta Lead Ads webhook would be a sibling route calling the same
 * landInboundLead with source "meta_lead_ad" — not a second consent path.
 */

/** Form id stored on the consent record as the source identifier. */
const FORM_ID = `self-hosted-opt-in:${CONSENT_DISCLOSURE_VERSION}`;

function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || null;
  return request.headers.get("x-real-ip");
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get("content-type") ?? "";
  const fromForm =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");

  let raw: unknown;
  if (fromForm) {
    raw = Object.fromEntries((await request.formData()).entries());
  } else {
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
  }

  const parsed = parseInboundLeadSubmission(raw);
  if (!parsed.ok) {
    if (fromForm) {
      return NextResponse.redirect(new URL("/opt-in?error=1", request.url), 303);
    }
    return NextResponse.json({ errors: parsed.errors }, { status: 400 });
  }

  try {
    const landed = await landInboundLead({
      submission: parsed.value,
      source: "web_form",
      leadSource: "inbound_form",
      sourceIdentifier: FORM_ID,
      ipAddress: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });

    if (fromForm) {
      return NextResponse.redirect(new URL("/opt-in/thanks", request.url), 303);
    }
    return NextResponse.json({
      ok: true,
      company_id: landed.companyId,
      contact_id: landed.contactId,
      consent_record_id: landed.consentRecordId,
      sms_consent: landed.smsConsent,
    });
  } catch (error) {
    console.error("[consent] opt-in submission failed", error);
    const message =
      error instanceof Error ? error.message : "Submission failed";
    if (fromForm) {
      return NextResponse.redirect(new URL("/opt-in?error=1", request.url), 303);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
