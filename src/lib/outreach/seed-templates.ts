import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outreachTemplates } from "@/lib/db/schema";
import {
  bookingConfirmationText,
  formatBookingWhen,
} from "@/lib/outreach/booking-confirmation";
import {
  resolveSchedulingLink,
  schedulingCallLength,
} from "@/lib/outreach/scheduling-link";

/**
 * Style exemplars for Claude (few-shot DNA) — NOT mail-merge templates.
 * They are never sent as-is. At enroll, Claude writes a NEW email/SMS about
 * the selected job listing, matching this voice/structure.
 *
 * Naming convention: "<Medium and step>, <what this one says>".
 * The first clause names the medium and where it sits in the sequence
 * ("Intro email", "Text 2", "Positive reply text"); the second says in plain
 * words what this particular exemplar does. One comma, never a parenthetical:
 * kind, channel and provenance are real columns and the admin UI renders them
 * as their own badge/column, so the name must not repeat them as "(intro)" or
 * "(won reply)". Every name states its medium so the email/text pairs of a
 * reply kind read in parallel.
 *
 * House style: no dashes or hyphens anywhere in name, subject, or body.
 */
const BOOKING_LINK = resolveSchedulingLink();
const CALL_LENGTH = schedulingCallLength(BOOKING_LINK);
/** "any 15 min" when the booking slug names a length, "any time" when it does not. */
const OPEN_SLOT = CALL_LENGTH ? `any ${CALL_LENGTH}` : "any time";

export const SEED_TEMPLATES: Array<{
  name: string;
  /** Older names we rename in place on seed. */
  legacyNames?: string[];
  kind:
    | "intro"
    | "followup_1"
    | "followup_2"
    | "text_1"
    | "text_2"
    | "text_3"
    | "reply_positive"
    | "reply_info_request"
    | "reply_decline"
    | "booking_confirmation";
  channel: "email" | "imessage";
  /** A real send that really got a reply, rather than written for coverage. */
  isProven?: boolean;
  exampleSubject?: string;
  exampleBody: string;
}> = [
  {
    name: "Intro email, boutique firm pitch",
    legacyNames: ["Boutique legal recruitment (won reply)"],
    kind: "intro",
    channel: "email",
    isProven: true,
    exampleSubject: "Boutique Legal Recruitment",
    exampleBody: `Hello,

I wanted to reach out this afternoon regarding supporting your team with legal recruitment.

I've spent the past 8+ years placing attorneys and legal staff across NY, CA, and FL, primarily working with firms that need strong candidates quickly and without the typical recruiting friction.

I run a boutique firm based in South Florida, which allows me to move fast, stay hands on, and deliver a more targeted approach. We keep our fees reasonable, guarantee our placements beyond 90 days, and are selective about the partners we take on.

If you're open to it, I'd welcome a quick call to understand your current hiring needs and see if there's a fit to work together.`,
  },
  {
    name: "Intro email, named open roles",
    legacyNames: [
      "Role specific technical intro (won reply)",
      "Role-specific technical intro (won reply)",
    ],
    kind: "intro",
    channel: "email",
    isProven: true,
    exampleSubject: "Support for Your Battery Storage Engineering Hires",
    exampleBody: `Hi Stacy,

I came across several of Plus Power's openings in West Palm Beach, including the Senior SCADA Controls Systems Engineer, Senior Project Commissioning Engineer, Senior Platform Backend Engineer, and Manager of AI Solutions & Analytics roles.

These are highly specialized positions, but they align well with the type of technical and leadership searches my team handles. I'm confident we can identify, thoroughly screen, and deliver qualified candidates for these openings in less than 20 days.

We work quickly while maintaining a strong focus on technical alignment, compensation expectations, location requirements, and long term fit, freeing up your team's time throughout the hiring process.

Would you be open to a quick conversation this week to discuss how Villatoro Executive Search could support these searches?`,
  },
  {
    name: "Follow up email 1, short nudge",
    legacyNames: ["Follow up 1, short nudge", "Follow-up 1, short nudge"],
    kind: "followup_1",
    channel: "email",
    exampleSubject: "Following up on your open roles",
    exampleBody: `Hi Stacy,

Following up on my note about your open roles. I know hiring for specialized positions while running the day to day is a lot to juggle.

If it would help, I can share how we'd approach the search and what a realistic timeline looks like, without adding work to your plate.

Worth a quick call this week?`,
  },
  {
    name: "Follow up email 2, last note",
    legacyNames: ["Follow up 2, final email", "Follow-up 2, final email"],
    kind: "followup_2",
    channel: "email",
    exampleSubject: "Last note on your hiring",
    exampleBody: `Hi Stacy,

I'll keep this short. If filling that role is still a priority, I'd welcome ten minutes to walk through how we'd run the search.

If the timing isn't right, no problem at all. Happy to reconnect whenever hiring picks back up.`,
  },
  {
    name: "Text 1, same day as the intro email",
    legacyNames: [
      "Text 1, same day intro",
      "Text 1, post email intro",
      "Text 1, post-email intro",
      "Text 1, post intro",
    ],
    kind: "text_1",
    channel: "imessage",
    exampleBody: `Hey, my name is Alejandro with V Executive Search. I've just emailed you about your Senior SCADA Controls Systems Engineer opening in West Palm Beach. When is a good time to chat?`,
  },
  {
    name: "Text 2, why us nudge",
    legacyNames: ["Text 2, value nudge"],
    kind: "text_2",
    channel: "imessage",
    exampleBody: `Hey Stacy, Alejandro again with V Executive Search. We move quickly on specialized searches like yours, happy to jump on a quick call if useful. When works this week?`,
  },
  {
    name: "Text 3, last note",
    legacyNames: ["Text 3, final"],
    kind: "text_3",
    channel: "imessage",
    exampleBody: `Hey Stacy, last note from me. If hiring support would help, I'm around, otherwise I'll leave you be. Best of luck with the search.`,
  },
  {
    name: "Positive reply email, send the booking link",
    legacyNames: ["Positive reply, availability"],
    kind: "reply_positive",
    channel: "email",
    exampleBody: `Hi Stacy,

Great to hear from you, happy to set up a quick call. Grab ${OPEN_SLOT} that works for you here:

${BOOKING_LINK}

If that link does not work for your schedule, reply with a couple of windows and I will make it happen. Looking forward to it.`,
  },
  {
    // Someone who replies by text gets answered by text, so the reply kinds
    // need a texting voice of their own. Without one the SMS auto-reply is
    // drafted against a multi paragraph email exemplar.
    name: "Positive reply text, send the booking link",
    legacyNames: ["Positive reply text, calendar link"],
    kind: "reply_positive",
    channel: "imessage",
    exampleBody: `Great, thanks Stacy. Easiest way is to grab ${CALL_LENGTH ?? "a time"} on my calendar here:

${BOOKING_LINK}

If nothing on there works, text me a couple of windows and I will make it happen.`,
  },
  {
    name: "Question reply email, promise the detail",
    legacyNames: ["Info request, hand off ack", "Info request, hand-off ack"],
    kind: "reply_info_request",
    channel: "email",
    exampleBody: `Hi Stacy,

Absolutely, happy to share more detail. Let me pull together the specifics on that and get back to you shortly with a proper answer.

In the meantime, if it's easier to cover live, I'm glad to jump on a quick call whenever suits you.`,
  },
  {
    name: "Question reply text, promise the detail",
    legacyNames: ["Info request text, hand off ack"],
    kind: "reply_info_request",
    channel: "imessage",
    exampleBody: `Good question Stacy. Let me pull the exact details and come back to you shortly with a proper answer. Happy to cover it on a quick call if that is easier.`,
  },
  {
    name: "Decline reply email, close warmly",
    legacyNames: ["Decline, graceful close"],
    kind: "reply_decline",
    channel: "email",
    exampleBody: `Hi Stacy,

Understood, thanks for letting me know. Wishing you the best with the search, and I'm happy to reconnect if hiring support would ever be useful down the road.`,
  },
  {
    name: "Decline reply text, close warmly",
    legacyNames: ["Decline text, graceful close"],
    kind: "reply_decline",
    channel: "imessage",
    exampleBody: `Totally understood Stacy, thanks for the quick reply. Best of luck with the search, and I am around if hiring support is ever useful.`,
  },
  {
    // Rendered from the same function that builds the real send, so the bank
    // always shows exactly what a contact receives.
    name: "Booking confirmation text, after they pick a time",
    legacyNames: ["Booking confirmation text"],
    kind: "booking_confirmation",
    channel: "imessage",
    exampleBody: bookingConfirmationText(
      formatBookingWhen(new Date("2026-08-03T13:00:00.000Z")),
    ),
  },
];

function legacyNamesFor(t: (typeof SEED_TEMPLATES)[number]): string[] {
  return [...(t.legacyNames ?? [])].filter(
    (n, i, arr) => n && n !== t.name && arr.indexOf(n) === i,
  );
}

/**
 * Insert missing seed exemplars and refresh wording for known seed names.
 * Renames legacy hyphenated titles; drops orphan duplicates once the new name exists.
 */
export async function seedOutreachTemplates(): Promise<number> {
  let changed = 0;
  for (const t of SEED_TEMPLATES) {
    const [existing] = await db
      .select()
      .from(outreachTemplates)
      .where(eq(outreachTemplates.name, t.name))
      .limit(1);

    const legacyNames = legacyNamesFor(t);

    if (!existing) {
      let legacy: { id: string } | undefined;
      for (const legacyName of legacyNames) {
        const [row] = await db
          .select()
          .from(outreachTemplates)
          .where(eq(outreachTemplates.name, legacyName))
          .limit(1);
        if (row) {
          legacy = row;
          break;
        }
      }
      if (legacy) {
        await db
          .update(outreachTemplates)
          .set({
            name: t.name,
            channel: t.channel,
            isProven: t.isProven ?? false,
            exampleSubject: t.exampleSubject ?? null,
            exampleBody: t.exampleBody,
            updatedAt: new Date(),
          })
          .where(eq(outreachTemplates.id, legacy.id));
        changed += 1;
        continue;
      }
      await db.insert(outreachTemplates).values({
        name: t.name,
        kind: t.kind,
        channel: t.channel,
        isProven: t.isProven ?? false,
        exampleSubject: t.exampleSubject ?? null,
        exampleBody: t.exampleBody,
        isActive: true,
      });
      changed += 1;
      continue;
    }

    if (
      existing.exampleBody !== t.exampleBody ||
      (existing.exampleSubject ?? null) !== (t.exampleSubject ?? null) ||
      existing.channel !== t.channel ||
      existing.isProven !== (t.isProven ?? false)
    ) {
      await db
        .update(outreachTemplates)
        .set({
          channel: t.channel,
          isProven: t.isProven ?? false,
          exampleSubject: t.exampleSubject ?? null,
          exampleBody: t.exampleBody,
          updatedAt: new Date(),
        })
        .where(eq(outreachTemplates.id, existing.id));
      changed += 1;
    }

    // Canonical row exists: remove leftover legacy-named duplicates.
    for (const legacyName of legacyNames) {
      const [orphan] = await db
        .select()
        .from(outreachTemplates)
        .where(eq(outreachTemplates.name, legacyName))
        .limit(1);
      if (orphan && orphan.id !== existing.id) {
        await db.delete(outreachTemplates).where(eq(outreachTemplates.id, orphan.id));
        changed += 1;
      }
    }
  }
  return changed;
}
