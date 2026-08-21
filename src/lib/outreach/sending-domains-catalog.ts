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
/** Shown in the inbox From: line on every outreach domain. */
export const FROM_DISPLAY_NAME = "V Executive Search";

export function rootDomainOf(domain: string): string {
  return domain.toLowerCase().split(".").filter(Boolean).slice(-2).join(".");
}

export function mailboxForDomain(domain: string): string {
  return `${FROM_LOCAL_PART}@${domain}`;
}

/** `V Executive Search <odv@domain>` — mailbox stays odv@, the visible name does not. */
export function fromAddressForDomain(domain: string): string {
  return applyFromDisplayName(mailboxForDomain(domain));
}

/**
 * Force the visible From name to V Executive Search on any mailbox
 * (`odv@x` or `Someone <odv@x>`). Mail clients otherwise show the local
 * part — "ODV" — when the address is bare.
 */
export function applyFromDisplayName(from: string): string {
  const email =
    from.match(/<([^>]+)>/)?.[1]?.trim() || from.trim();
  if (!email.includes("@")) return from;
  return `${FROM_DISPLAY_NAME} <${email}>`;
}
