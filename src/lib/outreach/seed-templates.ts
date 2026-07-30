import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outreachTemplates } from "@/lib/db/schema";

/**
 * Winning-email exemplars, style DNA for the LLM drafter, treated strictly
 * as data. The first two are the real sent emails that got replies
 * (boutique legal recruitment intro; role-specific technical intro). The
 * rest are hand-written in the same voice so every step kind has at least
 * one active exemplar. All editable in Admin → Outreach → Templates.
 */
const SEED_TEMPLATES: Array<{
  name: string;
  kind:
    | "intro"
    | "followup_1"
    | "followup_2"
    | "text_1"
    | "text_2"
    | "text_3"
    | "reply_positive"
    | "reply_info_request";
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

I run a boutique firm based in South Florida, which allows me to move fast, stay hands-on, and deliver a more targeted approach. We keep our fees reasonable, guarantee our placements beyond 90 days, and are selective about the partners we take on.

If you're open to it, I'd welcome a quick call to understand your current hiring needs and see if there's a fit to work together.`,
  },
  {
    name: "Role-specific technical intro (won reply)",
    kind: "intro",
    channel: "email",
    exampleSubject: "Support for Your Battery Storage Engineering Hires",
    exampleBody: `Hi Stacy,

I came across several of Plus Power's openings in West Palm Beach, including the Senior SCADA Controls Systems Engineer, Senior Project Commissioning Engineer, Senior Platform Backend Engineer, and Manager of AI Solutions & Analytics roles.

These are highly specialized positions, but they align well with the type of technical and leadership searches my team handles. I'm confident we can identify, thoroughly screen, and deliver qualified candidates for these openings in less than 20 days.

We work quickly while maintaining a strong focus on technical alignment, compensation expectations, location requirements, and long-term fit, freeing up your team's time throughout the hiring process.

Would you be open to a quick conversation this week to discuss how Villatoro Executive Search could support these searches?`,
  },
  {
    name: "Follow-up 1, short nudge",
    kind: "followup_1",
    channel: "email",
    exampleSubject: "Following up on your open roles",
    exampleBody: `Hi Stacy,

Following up on my note from earlier this week about your open roles. I know hiring for specialized positions while running the day-to-day is a lot to juggle.

If it would help, I can share a couple of recent placements we made for similar roles so you can see the caliber of candidates we deliver and how quickly we move.

Worth a quick call this week or next?`,
  },
  {
    name: "Follow-up 2, final email",
    kind: "followup_2",
    channel: "email",
    exampleSubject: "Last note on your hiring",
    exampleBody: `Hi Stacy,

I'll keep this short since I know your inbox is busy. If filling your open roles is still a priority this quarter, I'd welcome ten minutes to walk through how we'd approach the search and what a realistic timeline looks like.

If the timing isn't right, no problem at all, happy to reconnect whenever hiring picks back up. Either way, I wish you a strong quarter.`,
  },
  {
    name: "Text 1, soft intro",
    kind: "text_1",
    channel: "imessage",
    exampleBody: `Hi Stacy, this is Alejandro Delgado with Villatoro Executive Search. I emailed you earlier this week about the open roles at Plus Power. Happy to share how we could help fill them quickly. Is there a good time for a brief call?`,
  },
  {
    name: "Text 2, value nudge",
    kind: "text_2",
    channel: "imessage",
    exampleBody: `Hi Stacy, Alejandro again from Villatoro Executive Search. We recently filled two similar roles in under three weeks and I think we could do the same for your openings. Would a 10-minute call this week work?`,
  },
  {
    name: "Text 3, final",
    kind: "text_3",
    channel: "imessage",
    exampleBody: `Hi Stacy, last note from me. If hiring support would help this quarter, I'd be glad to talk whenever works for you. Otherwise I'll leave you be, and best of luck with the searches.`,
  },
  {
    name: "Positive reply, availability",
    kind: "reply_positive",
    channel: "email",
    exampleBody: `Hi Stacy,

Great to hear from you, happy to set up a quick call. Here are a few windows that work on my end this week:

Tuesday 10:00 to 10:30 AM ET
Wednesday 2:00 to 2:30 PM ET
Thursday 11:00 to 11:30 AM ET

If none of those work, let me know what suits your schedule and I'll make it happen. Looking forward to it.`,
  },
  {
    name: "Info request, hand-off ack",
    kind: "reply_info_request",
    channel: "email",
    exampleBody: `Hi Stacy,

Absolutely, happy to share more detail. Let me pull together the specifics on that and get back to you shortly with a proper answer.

In the meantime, if it's easier to cover live, I'm glad to jump on a quick call whenever suits you.`,
  },
];

/**
 * Insert missing seed templates and refresh wording for known seed names
 * (so dash/comma edits ship without wiping user-customized templates that
 * use different names).
 */
export async function seedOutreachTemplates(): Promise<number> {
  let changed = 0;
  for (const t of SEED_TEMPLATES) {
    const [existing] = await db
      .select()
      .from(outreachTemplates)
      .where(eq(outreachTemplates.name, t.name))
      .limit(1);
    if (!existing) {
      // Also refresh older seed names that used em-dash titles.
      const legacyName = t.name.replace(", ", " — ");
      const [legacy] = legacyName !== t.name
        ? await db
            .select()
            .from(outreachTemplates)
            .where(eq(outreachTemplates.name, legacyName))
            .limit(1)
        : [undefined];
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
  }
  return changed;
}
