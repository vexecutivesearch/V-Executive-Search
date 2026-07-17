import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  discoverCompanyContacts,
  getCachedCandidates,
} from "@/lib/enrich/discovery";
import { manualEnrichContext, PaidEgressBlockedError } from "@/lib/paid-egress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Discovery — reveal-off people search. Returns candidate decision-makers
 * (name · title · LinkedIn · location) with ZERO reveal credits spent.
 * Cached per company: the search credit is paid once, ever; re-opening the
 * picker reuses the cache. `{ force: true }` is the explicit, user-initiated
 * corrective re-discovery (a second search credit).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "APOLLO_API_KEY is not configured." },
      { status: 503 },
    );
  }

  const { id } = await params;
  let force = false;
  try {
    const body = (await request.json()) as { force?: boolean };
    force = body.force === true;
  } catch {
    // empty body = default discovery
  }

  try {
    // Serve the cache without touching any paid endpoint.
    if (!force) {
      const cached = await getCachedCandidates(id);
      if (cached) {
        return NextResponse.json({
          ...cached,
          cost_note:
            "Loaded from cache — no search credit spent, no reveal credits spent.",
        });
      }
    }

    const result = await discoverCompanyContacts({
      companyId: id,
      apiKey,
      context: manualEnrichContext(id),
      force,
    });

    revalidatePath(`/companies/${id}`);
    revalidatePath("/crm");

    return NextResponse.json({
      ...result,
      cost_note: `Discovery: ${result.searchesSpent} search credit${result.searchesSpent === 1 ? "" : "s"} spent · 0 reveal credits (reveal is a separate, per-contact choice).`,
    });
  } catch (err) {
    if (err instanceof PaidEgressBlockedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    const message = err instanceof Error ? err.message : "Discovery failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
