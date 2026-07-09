import { CompanyStatus } from "@/lib/db/schema";

export const STATUS_LABELS: Record<CompanyStatus, string> = {
  new: "New",
  contacted: "Contacted",
  meeting: "Meeting",
  client: "Client",
  skipped: "Skipped",
};

export const STATUS_COLORS: Record<CompanyStatus, string> = {
  new: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  contacted:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  meeting:
    "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200",
  client:
    "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  skipped: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
