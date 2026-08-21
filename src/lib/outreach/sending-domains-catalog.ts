/**
 * Sending domains that rotate through pickSendingProfile.
 *
 * The first three have been in production for about a month. The rest were
 * added on Cloudflare + Resend on 2026-08-21.
 */
export const ESTABLISHED_SENDING_DOMAINS = [
  "vexecsearch.com",
  "vexecutivesearch.co",
  "vtalentsearch.com",
] as const;

export const NEW_SENDING_DOMAINS = [
  "vexecutivetalent.com",
  "vexecutiverecruit.us",
  "vexecutives.com",
  "vexecutiverecruit.work",
  "villatororecruiting.us",
] as const;

export const CATALOG_SENDING_DOMAINS = [
  ...ESTABLISHED_SENDING_DOMAINS,
  ...NEW_SENDING_DOMAINS,
] as const;

export type CatalogSendingDomain = (typeof CATALOG_SENDING_DOMAINS)[number];

/** Watched mailbox. Replies still land on the IMAP poll. */
export const DEFAULT_REPLY_TO_ADDRESS = "odv@vexecutivesearch.com";
export const FROM_LOCAL_PART = "odv";

export function rootDomainOf(domain: string): string {
  return domain.toLowerCase().split(".").filter(Boolean).slice(-2).join(".");
}

/**
 * Keep the display-name wrapper from an existing profile when one exists
 * (`Alejandro O Delgado <odv@vexecsearch.com>`), otherwise the bare local
 * part the established domains already use.
 */
export function fromAddressForDomain(
  domain: string,
  templateFrom?: string | null,
): string {
  const address = `${FROM_LOCAL_PART}@${domain}`;
  const display = templateFrom?.match(/^(.*)<[^>]+>\s*$/);
  const name = display?.[1]?.trim();
  return name ? `${name} <${address}>` : address;
}
