import {
  DEFAULT_REPLY_TO_ADDRESS,
  NEW_SENDING_DOMAINS,
  fromAddressForDomain,
} from "@/lib/outreach/sending-domains-catalog";
import {
  resolveProfileApiKey,
  sendOutreachEmail,
} from "@/lib/outreach/resend-send";

export const DEFAULT_DOMAIN_TEST_TO = "hello@proventheory.co";

export type DomainTestResult = {
  domain: string;
  from: string;
  ok: boolean;
  resendId?: string;
  error?: string;
};

/**
 * One live Resend send per domain. Used to prove a newly verified domain
 * can leave Resend before it is asked to carry real outreach. Does not
 * touch sending_profiles counters or the daily cap.
 */
export async function sendCatalogTestEmails(options: {
  to?: string;
  domains?: readonly string[];
  apiKey?: string | null;
}): Promise<DomainTestResult[]> {
  const to = options.to?.trim() || DEFAULT_DOMAIN_TEST_TO;
  const domains = options.domains?.length
    ? options.domains
    : NEW_SENDING_DOMAINS;
  const apiKey = options.apiKey ?? resolveProfileApiKey(null);
  if (!apiKey) {
    return domains.map((domain) => ({
      domain,
      from: fromAddressForDomain(domain),
      ok: false,
      error: "RESEND_API_KEY is not set",
    }));
  }

  const results: DomainTestResult[] = [];
  for (const domain of domains) {
    const from = fromAddressForDomain(domain);
    const sent = await sendOutreachEmail({
      apiKey,
      from,
      to,
      replyTo: DEFAULT_REPLY_TO_ADDRESS,
      subject: `Sending-domain test — ${domain}`,
      textBody: [
        `This is a one-off deliverability test from ${from}.`,
        "",
        "If this arrived, Resend accepts this domain and the CRM can rotate it on call-list outreach.",
        "",
        "You can ignore this message.",
      ].join("\n"),
    });
    results.push(
      sent.ok
        ? { domain, from, ok: true, resendId: sent.resendId }
        : { domain, from, ok: false, error: sent.error },
    );
  }
  return results;
}
