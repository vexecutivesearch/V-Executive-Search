import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, jobListings } from "@/lib/db/schema";
import { getGeoFocusSettings, jobLocationInFocus } from "@/lib/geo-focus";

const DEFAULT_MODEL = "claude-3-5-haiku-20241022";

export type OpenerInput = {
  companyName: string;
  jobTitle: string;
  jobLocation: string | null;
  reasonToCall: string | null;
  contactName?: string | null;
  contactTitle?: string | null;
};

export async function generateCallOpenerText(
  input: OpenerInput,
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENER_MODEL ?? DEFAULT_MODEL;
  const prompt = `You write short cold-call openers for an executive recruiter.

Company: ${input.companyName}
Job posting: ${input.jobTitle}${input.jobLocation ? ` (${input.jobLocation})` : ""}
Why call now: ${input.reasonToCall ?? "Active hiring in their market"}
${input.contactName ? `Contact: ${input.contactName}${input.contactTitle ? `, ${input.contactTitle}` : ""}` : ""}

Write ONE natural opener (2-3 sentences max) the recruiter says after "Hi, is this [name]?".
Reference the specific role and hiring pain. No placeholders. No bullet points. Conversational tone.`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 220,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) {
      console.error("Anthropic opener failed:", await resp.text());
      return null;
    }

    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((c) => c.type === "text")?.text?.trim();
    return text || null;
  } catch (err) {
    console.error("Anthropic opener error:", err);
    return null;
  }
}

export async function generateAndStoreOpener(
  companyId: string,
  options?: { force?: boolean },
): Promise<{ opener: string | null; generated: boolean }> {
  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  if (!company) return { opener: null, generated: false };

  if (
    !options?.force &&
    company.callOpener &&
    company.callOpenerGeneratedAt &&
    company.reasonToCall
  ) {
    return { opener: company.callOpener, generated: false };
  }

  const geoSettings = await getGeoFocusSettings();
  const listings = await db
    .select()
    .from(jobListings)
    .where(eq(jobListings.companyId, companyId));

  const inFocus = listings.filter((l) =>
    jobLocationInFocus(l.location, geoSettings),
  );
  const primaryJob = inFocus[0] ?? listings[0];

  if (!primaryJob?.title) {
    return { opener: company.callOpener, generated: false };
  }

  const opener = await generateCallOpenerText({
    companyName: company.name,
    jobTitle: primaryJob.title,
    jobLocation: primaryJob.location,
    reasonToCall: company.reasonToCall,
  });

  if (!opener) {
    return { opener: company.callOpener, generated: false };
  }

  await db
    .update(companies)
    .set({
      callOpener: opener,
      callOpenerGeneratedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(companies.id, companyId));

  return { opener, generated: true };
}

export async function generateOpenersForCompanies(
  companyIds: string[],
  options?: { force?: boolean },
): Promise<{ generated: number; skipped: number }> {
  const maxPerRun = Number(process.env.OPENER_MAX_PER_RUN ?? 25);
  const ids = companyIds.slice(0, maxPerRun);
  let generated = 0;
  let skipped = 0;

  for (const id of ids) {
    const result = await generateAndStoreOpener(id, options);
    if (result.generated) generated += 1;
    else skipped += 1;
  }

  return { generated, skipped };
}
