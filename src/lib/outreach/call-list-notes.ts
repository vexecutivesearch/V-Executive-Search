/**
 * Call List note ordering helpers (client + server safe — no DB imports).
 *
 * Automated outreach lines use stampLine() in call-list-sync:
 * `[Jul 30, 4:50 PM] …` — newest should appear at the top.
 */

/** Matches stampLine() output: `[Jul 30, 4:50 PM] …` */
const STAMP_RE =
  /^\[((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)\]/i;

function parseStampDate(line: string): Date | null {
  const m = line.trim().match(STAMP_RE);
  if (!m) return null;
  const d = new Date(m[1]);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * If notes look like oldest→newest stamped lines (legacy append order),
 * reverse them so newest is on top. Leaves free-form / already-newest-first
 * blobs alone when chronological order is unclear or already correct.
 *
 * Every adjacent pair has to agree before we reverse. Comparing only the top
 * and bottom line misreads rows whose stamps straddle the switch from UTC to
 * Eastern: one fresh Eastern line can read hours *earlier* than the UTC lines
 * below it, which used to flip an already-correct row upside down.
 */
export function ensureNotesNewestFirst(notes: string | null | undefined): string {
  if (!notes?.trim()) return notes ?? "";
  const normalized = notes.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const stamped = lines
    .map((line, index) => ({ index, date: parseStampDate(line) }))
    .filter((x): x is { index: number; date: Date } => x.date != null);
  if (stamped.length < 2) return normalized;

  let ascending = 0;
  let descending = 0;
  for (let i = 1; i < stamped.length; i += 1) {
    const prev = stamped[i - 1].date.getTime();
    const next = stamped[i].date.getTime();
    if (next > prev) ascending += 1;
    else if (next < prev) descending += 1;
  }

  // Only a wholly oldest-first blob gets reversed.
  if (ascending > 0 && descending === 0) {
    return [...lines].reverse().join("\n");
  }
  return normalized;
}
