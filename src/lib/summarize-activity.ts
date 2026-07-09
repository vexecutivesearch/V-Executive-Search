const DEFAULT_MODEL = "claude-3-5-haiku-20241022";

export type ActivitySummaryResult = {
  summary: string;
  classification: string | null;
  suggestedStatus: string | null;
};

export async function summarizeCallTranscript(input: {
  companyName: string;
  contactName?: string | null;
  transcript: string;
}): Promise<ActivitySummaryResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENER_MODEL ?? DEFAULT_MODEL;
  const prompt = `Summarize this recruiter call transcript for CRM logging.

Company: ${input.companyName}
${input.contactName ? `Contact: ${input.contactName}` : ""}

Transcript:
"""
${input.transcript.slice(0, 8000)}
"""

Respond in JSON only with keys:
- summary: 2-4 sentence recap for the activity timeline
- classification: one of "positive", "neutral", "not_interested", "callback", "voicemail"
- suggestedStatus: one of "contacted", "meeting", "skipped", or null if no change`;

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
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const raw = data.content?.find((c) => c.type === "text")?.text?.trim();
    if (!raw) return null;

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      summary?: string;
      classification?: string;
      suggestedStatus?: string | null;
    };

    if (!parsed.summary) return null;

    return {
      summary: parsed.summary,
      classification: parsed.classification ?? null,
      suggestedStatus: parsed.suggestedStatus ?? null,
    };
  } catch {
    return null;
  }
}
