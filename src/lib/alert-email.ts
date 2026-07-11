export function parseEmailRecipients(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/[,;]/)
    .map((email) => email.trim())
    .filter((email) => email.includes("@"));
}

export async function sendAlertEmail(options: {
  toEmail: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("RESEND_API_KEY not set — cannot send alert email");
    return false;
  }

  const recipients = parseEmailRecipients(options.toEmail);
  if (recipients.length === 0) {
    console.error("No valid alert email recipients");
    return false;
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
      }
    }

    if (!resp.ok) {
      console.error("Alert email failed:", await resp.text());
      return false;
    }

    return true;
  } catch (err) {
    console.error("Alert email error:", err);
    return false;
  }
}
