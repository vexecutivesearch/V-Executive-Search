import type { Metadata } from "next";
import { consentBusinessName } from "@/lib/consent/disclosure";

export const metadata: Metadata = {
  title: "Terms of Service",
  robots: { index: false },
};

/**
 * Placeholder so the opt-in form's Terms of Service link resolves. Carrier
 * review for A2P 10DLC follows this link, so it must contain real terms before
 * a campaign is submitted.
 */
export default function TermsOfServicePage() {
  const businessName = consentBusinessName();
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold">Terms of Service</h1>

      <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="font-medium">This page is a placeholder.</p>
        <p className="mt-1">
          {businessName} must publish real terms here before running ads at the
          opt-in page or submitting an A2P 10DLC campaign for carrier review.
        </p>
      </div>

      <ul className="mt-6 list-disc space-y-1.5 pl-5 text-sm text-gray-600 dark:text-gray-400">
        <li>Who the service is for and what it does.</li>
        <li>
          Messaging terms: message frequency, that message and data rates may
          apply, HELP for help, STOP to opt out.
        </li>
        <li>Supported carriers disclaimer and delivery limitations.</li>
        <li>Governing law and a contact address.</li>
      </ul>
    </div>
  );
}
