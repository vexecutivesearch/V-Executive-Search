export function parseEmailRecipients(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/[,;]/)
    .map((email) => email.trim())
    .filter((email) => email.includes("@"));
}

export type SendAlertEmailResult =
  | { ok: true }
  | { ok: false; error: string };

export async function sendAlertEmail(options: {
  toEmail: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  const result = await sendAlertEmailDetailed(options);
  return result.ok;
}

/** Same as sendAlertEmail, but returns the failure reason for API responses. */
export async function sendAlertEmailDetailed(options: {
  toEmail: string;
  subject: string;
  html: string;
}): Promise<SendAlertEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("RESEND_API_KEY not set — cannot send alert email");
    return { ok: false, error: "RESEND_API_KEY is not set on this deployment" };
  }

  const recipients = parseEmailRecipients(options.toEmail);
  if (recipients.length === 0) {
    console.error("No valid alert email recipients");
    return { ok: false, error: "No valid recipient email" };
  }

  const fromEmail =
    process.env.REPORT_FROM_EMAIL ?? "V Executive Search <onboarding@resend.dev>";
  const fallbackFrom = "V Executive Search <onboarding@resend.dev>";

  const payload = {
    from: fromEmail,
    to: recipients,
    subject: options.subject,
    html: options.html,
  };

  try {
    let resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (resp.status === 403) {
      const text = await resp.text();
      if (text.toLowerCase().includes("domain is not verified")) {
        resp = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...payload, from: fallbackFrom }),
        });
      } else {
        console.error("Alert email failed:", text);
        return { ok: false, error: text.slice(0, 300) };
      }
    }

    if (!resp.ok) {
      const text = await resp.text();
      console.error("Alert email failed:", text);
      return { ok: false, error: text.slice(0, 300) || `Resend HTTP ${resp.status}` };
    }

    return { ok: true };
  } catch (err) {
    console.error("Alert email error:", err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown email error",
    };
  }
}
