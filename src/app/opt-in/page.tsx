import type { Metadata } from "next";
import { OptInForm } from "@/components/consent/OptInForm";
import { consentBusinessName, currentDisclosure } from "@/lib/consent/disclosure";

export const metadata: Metadata = {
  title: "Hiring help — opt in",
  description:
    "Tell us what you are hiring for and how you would like to be contacted.",
};

/**
 * Landing page for the consented inbound lane. Meta and any other paid ads
 * point here rather than at a native lead form, because this page controls the
 * disclosure wording that carrier review and E-SIGN both depend on.
 */
export default function OptInPage() {
  const disclosure = currentDisclosure();
  const businessName = consentBusinessName();

  return (
    <div className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-2xl font-bold">Hiring? Tell us the role.</h1>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        {businessName} places professional staff for firms that are hiring right
        now. Send the details and a recruiter will come back to you with
        candidates, not a brochure.
      </p>

      <div className="mt-6 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-5 shadow-sm">
        <OptInForm disclosure={disclosure} />
      </div>
    </div>
  );
}
