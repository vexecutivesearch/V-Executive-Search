/** JobSpy board ids — must match python-jobspy Site enum values. */
export const JOB_BOARD_IDS = [
  "indeed",
  "google",
  "linkedin",
  "zip_recruiter",
  "glassdoor",
] as const;

export type JobBoardId = (typeof JOB_BOARD_IDS)[number];

export type JobBoardOption = {
  id: JobBoardId;
  label: string;
  description: string;
  defaultEnabled: boolean;
};

export const JOB_BOARD_OPTIONS: JobBoardOption[] = [
  {
    id: "indeed",
    label: "Indeed",
    description: "Broad US coverage; reliable baseline.",
    defaultEnabled: true,
  },
  {
    id: "google",
    label: "Google Jobs",
    description:
      "Uses SerpApi on the Mac worker when SERPAPI_API_KEY is set. Auto-enables at scrape time with a key; leave unchecked otherwise.",
    defaultEnabled: false,
  },
  {
    id: "linkedin",
    label: "LinkedIn Jobs",
    description:
      "Strong for senior and corporate roles. Higher block risk — keep enabled but watch logs.",
    defaultEnabled: true,
  },
  {
    id: "zip_recruiter",
    label: "ZipRecruiter",
    description:
      "Often blocked lately. Safe to leave on — gaps show as a warning and won’t empty the backlog. Overlaps Indeed.",
    defaultEnabled: true,
  },
  {
    id: "glassdoor",
    label: "Glassdoor",
    description: "Overlaps with Indeed (same parent); mostly duplicates.",
    defaultEnabled: false,
  },
];

export const DEFAULT_JOB_BOARDS: JobBoardId[] = JOB_BOARD_OPTIONS.filter(
  (b) => b.defaultEnabled,
).map((b) => b.id);

const JOB_BOARD_SET = new Set<string>(JOB_BOARD_IDS);

export function isJobBoardId(value: string): value is JobBoardId {
  return JOB_BOARD_SET.has(value);
}

/** Sanitize admin/worker board list; fall back to defaults when empty. */
export function resolveJobBoards(
  values: string[] | null | undefined,
): JobBoardId[] {
  if (!values?.length) return [...DEFAULT_JOB_BOARDS];

  const out: JobBoardId[] = [];
  for (const raw of values) {
    const id = raw.trim().toLowerCase();
    if (isJobBoardId(id) && !out.includes(id)) {
      out.push(id);
    }
  }

  return out.length ? out : [...DEFAULT_JOB_BOARDS];
}
