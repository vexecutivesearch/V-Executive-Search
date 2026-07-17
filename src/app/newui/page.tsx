import { NewUiApp, type PreviewData } from "@/components/newui/NewUiApp";
import {
  getCallListItems,
  getConsolidatedListings,
  getCrmKpis,
  getCrmLeads,
  getCrmTabCounts,
  getLocationRailCounts,
} from "@/lib/crm-queries";
import { CALL_STATUS_LABELS } from "@/lib/call-status";
import { contactIsCallable } from "@/lib/lead-score";
import { sectorFromIndustry } from "@/lib/industry-sectors";
import { formatListingSalary, pickDisplayListing } from "@/lib/salary-format";
import { businessListDate } from "@/lib/timezone";
import { SAMPLE_PREVIEW } from "@/components/newui/sample-data";

export const dynamic = "force-dynamic";

const PREVIEW_ROWS = 40;

/**
 * /newui — a dark, glassmorphic preview of the Pipeline UI. Read-only reskin
 * over the real data (falls back to sample data if the DB is unreachable) so
 * the look-and-feel can be reviewed before deciding to ship a dark theme.
 */
export default async function NewUiPage() {
  let data: PreviewData;
  try {
    const [kpis, counts, rail, leads, listings, callList] = await Promise.all([
      getCrmKpis(businessListDate()),
      getCrmTabCounts(),
      getLocationRailCounts(),
      getCrmLeads({ sort: "icp" }),
      getConsolidatedListings({ sort: "newest" }),
      getCallListItems(),
    ]);

    data = {
      live: true,
      kpis,
      counts,
      states: rail.states.slice(0, 10).map((s) => ({
        stateName: s.stateName,
        stateAbbr: s.stateAbbr,
        count: s.count,
        cities: s.cities.slice(0, 6),
      })),
      totalLocations: rail.total,
      leads: leads.rows.slice(0, PREVIEW_ROWS).map((r) => {
        const job = r.jobListings[0];
        const salaryJob = pickDisplayListing(r.jobListings);
        return {
          id: r.id,
          name: r.name,
          domain: r.domain,
          score: r.leadScore ?? 0,
          icpScore: r.icp?.adjustedScore ?? null,
          roleType: r.icp?.roleType ?? null,
          marketLabel: r.marketLabel,
          jobTitle: job?.title ?? null,
          jobBoard: job?.board ?? null,
          jobLocation: job?.location ?? null,
          salary: salaryJob ? formatListingSalary(salaryJob) : null,
          sector: sectorFromIndustry(r.industry) ?? r.industry ?? null,
          contactsCallable: r.contacts.filter(contactIsCallable).length,
          contactsTotal: r.contacts.length,
          discovered: r.contacts.filter((c) => c.revealStatus === "discovered").length,
          hot: Object.keys(r.hiringSignals ?? {}).length > 0,
          onList: r.onCallList,
          reasonToCall: r.reasonToCall ?? null,
        };
      }),
      listings: listings.rows.slice(0, PREVIEW_ROWS).map((l) => ({
        id: l.id,
        title: l.title,
        company: l.companyName,
        location: l.location,
        board: l.board,
        market: l.marketLabel,
        reposts: l.sightingsCount,
        postedAt: (l.postedAt ?? l.firstSeenAt) instanceof Date
          ? (l.postedAt ?? l.firstSeenAt).toISOString()
          : String(l.postedAt ?? l.firstSeenAt),
      })),
      callList: callList.slice(0, PREVIEW_ROWS).map((item) => {
        const c =
          item.company.contacts.find((x) => x.id === item.entry.primaryContactId) ??
          item.company.contacts[0];
        return {
          id: item.entry.id,
          company: item.company.name,
          score: item.company.leadScore ?? 0,
          contactName: c?.name ?? null,
          contactTitle: c?.title ?? null,
          status: CALL_STATUS_LABELS[item.entry.callStatus],
          attempts: item.entry.attempts,
          nextFollowUp: item.entry.nextFollowUpDate,
          assignedTo: item.entry.assignedTo,
          market: item.marketLabel,
        };
      }),
    };
  } catch {
    data = SAMPLE_PREVIEW;
  }

  return (
    <div className="newui-root fixed inset-0 z-[100] overflow-y-auto">
      <NewUiApp data={data} />
    </div>
  );
}
