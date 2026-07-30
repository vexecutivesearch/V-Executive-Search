import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outreachTemplates } from "@/lib/db/schema";

/**
 * Style exemplars for Claude (few-shot DNA) — NOT mail-merge templates.
 * They are never sent as-is. At enroll, Claude writes a NEW email/SMS about
 * the selected job listing, matching this voice/structure.
 *
 * House style: no dashes or hyphens anywhere in name, subject, or body.
 */
const SEED_TEMPLATES: Array<{
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
    | "reply_decline";
  channel: "email" | "imessage";
  exampleSubject?: string;
  exampleBody: string;
}> = [
  {
    name: "Boutique legal recruitment (won reply)",
    kind: "intro",
    channel: "email",
    exampleSubject: "Boutique Legal Recruitment",
    exampleBody: `Hello,

I wanted to reach out this afternoon regarding supporting your team with legal recruitment.

I've spent the past 8+ years placing attorneys and legal staff across NY, CA, and FL, primarily working with firms that need strong candidates quickly and without the typical recruiting friction.

I run a boutique firm based in South Florida, which allows me to move fast, stay hands on, and deliver a more targeted approach. We keep our fees reasonable, guarantee our placements beyond 90 days, and are selective about the partners we take on.

If you're open to it, I'd welcome a quick call to understand your current hiring needs and see if there's a fit to work together.`,
  },
  {
    name: "Role specific technical intro (won reply)",
    legacyNames: ["Role-specific technical intro (won reply)"],
    kind: "intro",
    channel: "email",
    exampleSubject: "Support for Your Battery Storage Engineering Hires",
    exampleBody: `Hi Stacy,

I came across several of Plus Power's openings in West Palm Beach, including the Senior SCADA Controls Systems Engineer, Senior Project Commissioning Engineer, Senior Platform Backend Engineer, and Manager of AI Solutions & Analytics roles.

These are highly specialized positions, but they align well with the type of technical and leadership searches my team handles. I'm confident we can identify, thoroughly screen, and deliver qualified candidates for these openings in less than 20 days.

We work quickly while maintaining a strong focus on technical alignment, compensation expectations, location requirements, and long term fit, freeing up your team's time throughout the hiring process.

Would you be open to a quick conversation this week to discuss how Villatoro Executive Search could support these searches?`,
  },
  {
    name: "Follow up 1, short nudge",
    legacyNames: ["Follow-up 1, short nudge"],
    kind: "followup_1",
    channel: "email",
    exampleSubject: "Following up on your open roles",
    exampleBody: `Hi Stacy,

Following up on my note about your open roles. I know hiring for specialized positions while running the day to day is a lot to juggle.

If it would help, I can share how we'd approach the search and what a realistic timeline looks like, without adding work to your plate.

Worth a quick call this week?`,
  },
  {
    name: "Follow up 2, final email",
    legacyNames: ["Follow-up 2, final email"],
    kind: "followup_2",
    channel: "email",
    exampleSubject: "Last note on your hiring",
    exampleBody: `Hi Stacy,

I'll keep this short. If filling that role is still a priority, I'd welcome ten minutes to walk through how we'd run the search.

If the timing isn't right, no problem at all. Happy to reconnect whenever hiring picks back up.`,
  },
  {
    name: "Text 1, post email intro",
    legacyNames: ["Text 1, post-email intro", "Text 1, post intro"],
    kind: "text_1",
    channel: "imessage",
    exampleBody: `Hey, my name is Alejandro with V Executive Search. I've sent you an email about your Senior SCADA Controls Systems Engineer opening in West Palm Beach. When is a good time to chat?`,
  },
  {
    name: "Text 2, value nudge",
    kind: "text_2",
    channel: "imessage",
    exampleBody: `Hey Stacy, Alejandro again with V Executive Search. We move quickly on specialized searches like yours, happy to jump on a quick call if useful. When works this week?`,
  },
  {
    name: "Text 3, final",
    kind: "text_3",
    channel: "imessage",
    exampleBody: `Hey Stacy, last note from me. If hiring support would help, I'm around, otherwise I'll leave you be. Best of luck with the search.`,
  },
  {
    name: "Positive reply, availability",
    kind: "reply_positive",
    channel: "email",
    exampleBody: `Hi Stacy,

Great to hear from you, happy to set up a quick call. Grab any 30 min that works for you here:

https://calendly.com/odv-vexecutivesearch/30min

If that link does not work for your schedule, reply with a couple of windows and I will make it happen. Looking forward to it.`,
  },
  {
    name: "Info request, hand off ack",
    legacyNames: ["Info request, hand-off ack"],
    kind: "reply_info_request",
    channel: "email",
    exampleBody: `Hi Stacy,

Absolutely, happy to share more detail. Let me pull together the specifics on that and get back to you shortly with a proper answer.

In the meantime, if it's easier to cover live, I'm glad to jump on a quick call whenever suits you.`,
  },
  {
    name: "Decline, graceful close",
    kind: "reply_decline",
    channel: "email",
    exampleBody: `Hi Stacy,

Understood, thanks for letting me know. Wishing you the best with the search, and I'm happy to reconnect if hiring support would ever be useful down the road.`,
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
        exampleSubject: t.exampleSubject ?? null,
        exampleBody: t.exampleBody,
        isActive: true,
      });
      changed += 1;
      continue;
    }

    if (
      existing.exampleBody !== t.exampleBody ||
      (existing.exampleSubject ?? null) !== (t.exampleSubject ?? null)
    ) {
      await db
        .update(outreachTemplates)
        .set({
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
