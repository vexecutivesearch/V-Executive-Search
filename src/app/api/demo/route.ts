import { NextResponse } from "next/server";
import { sendAlertEmailDetailed } from "@/lib/alert-email";

const DEMO_TO = "tech@vexecutivesearch.com";

type DemoBody = {
  name?: string;
  company?: string;
  email?: string;
  phone?: string;
  message?: string;
  interests?: string[] | string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:8px 12px;border:1px solid #ddd;font-weight:600;width:140px;">${escapeHtml(label)}</td><td style="padding:8px 12px;border:1px solid #ddd;">${escapeHtml(value)}</td></tr>`;
}

export async function POST(request: Request) {
  let body: DemoBody;
  try {
    body = (await request.json()) as DemoBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = body.name?.trim() ?? "";
  const email = body.email?.trim() ?? "";
  if (!name || !email || !email.includes("@")) {
    return NextResponse.json({ error: "Name and work email are required" }, { status: 400 });
  }

  const interests = Array.isArray(body.interests)
    ? body.interests.map(String).filter(Boolean)
    : typeof body.interests === "string" && body.interests.trim()
      ? [body.interests.trim()]
      : [];

  const html = `
    <h2>New demo request — Villatoro platform</h2>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
      ${row("Name", name)}
      ${row("Company", body.company?.trim() || "—")}
      ${row("Email", email)}
      ${row("Phone", body.phone?.trim() || "—")}
      ${row("Interests", interests.length ? interests.join(", ") : "(general demo)")}
      ${row("Message", body.message?.trim() || "—")}
    </table>
  `;

  const result = await sendAlertEmailDetailed({
    toEmail: process.env.DEMO_REQUEST_EMAIL ?? DEMO_TO,
    subject: "New demo request — Villatoro platform",
    html,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: "Email delivery unavailable", detail: result.error },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true });
}
