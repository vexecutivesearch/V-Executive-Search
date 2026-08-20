import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { companyReviewStatusEnum } from "@/lib/db/schema";
import { setCompanyReviewStatus } from "@/lib/discovery/review-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID = new Set<string>(companyReviewStatusEnum.enumValues);

/**
 * Review action from the discovery queue. Free — approving for enrichment is a
 * separate, explicit call so a mis-click can never spend a reveal credit.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: { status?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const status = body.status?.trim();
  if (!status || !VALID.has(status)) {
    return NextResponse.json(
      {
        error: `status must be one of: ${companyReviewStatusEnum.enumValues.join(", ")}`,
      },
      { status: 400 },
    );
  }

  try {
    await setCompanyReviewStatus(
      id,
      status as (typeof companyReviewStatusEnum.enumValues)[number],
    );
    revalidatePath("/crm");
    revalidatePath(`/companies/${id}`);
    return NextResponse.json({ ok: true, review_status: status });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Review update failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
