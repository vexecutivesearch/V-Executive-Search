"use client";

import { formatDate } from "@/lib/utils";
import Link from "next/link";
import { EnrichButton } from "./EnrichButton";

export type JobRow = {
  id: string;
  title: string;
  board: string | null;
  url: string | null;
  location: string | null;
  postedAt: Date | null;
  companyId: string;
  companyName: string;
  contactCount: number;
};

export function JobsTable({ jobs }: { jobs: JobRow[] }) {
  return (
    <div className="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-xl">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 dark:bg-gray-900 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-4 py-3">Posted</th>
            <th className="px-4 py-3">Title</th>
            <th className="px-4 py-3">Company</th>
            <th className="px-4 py-3">Location</th>
            <th className="px-4 py-3">Board</th>
            <th className="px-4 py-3">Link</th>
            <th className="px-4 py-3">Enrich</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {jobs.map((job) => (
            <tr key={job.id} className="hover:bg-gray-50 dark:hover:bg-gray-900/50">
              <td className="px-4 py-3 whitespace-nowrap text-gray-500">
                {formatDate(job.postedAt?.toISOString())}
              </td>
              <td className="px-4 py-3 font-medium">{job.title}</td>
              <td className="px-4 py-3">
                <Link
                  href={`/companies/${job.companyId}`}
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  {job.companyName}
                </Link>
              </td>
              <td className="px-4 py-3 text-gray-500">{job.location || "—"}</td>
              <td className="px-4 py-3 text-gray-500">{job.board || "—"}</td>
              <td className="px-4 py-3">
                {job.url ? (
                  <a
                    href={job.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    View
                  </a>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-4 py-3">
                <EnrichButton
                  companyId={job.companyId}
                  contactCount={job.contactCount}
                  compact
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
