/**
 * Defaults for the reveal picker.
 *
 * Phone stays an explicit, visible opt-in (it is the scarcest credit and the
 * cost preview always shows the count), but it must DEFAULT ON for a contact
 * that has no direct number. When it defaults off, the reveal sends
 * `channels: "email"`, the ContactOut `include_phone=true` lookup is never
 * made, and the result still reports "0 phones found" — which reads as a
 * ContactOut failure even though nothing ever asked for a phone.
 */
export function shouldDefaultPhoneOn(candidate: { hasPhone: boolean }): boolean {
  return !candidate.hasPhone;
}
