import type { Metadata } from "next";
import { consentBusinessName } from "@/lib/consent/disclosure";

export const metadata: Metadata = {
  title: "Privacy Policy",
  robots: { index: false },
};

/**
 * Placeholder so the opt-in form's Privacy Policy link resolves. The operator
 * must replace this with real policy text before running ads at /opt-in or
 * submitting an A2P 10DLC campaign — carrier review reads this page, and the
 * clause about not sharing mobile opt-in data is mandatory, not optional.
 */
export default function PrivacyPolicyPage() {
  const businessName = consentBusinessName();
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold">Privacy Policy</h1>

      <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <p className="font-medium">This page is a placeholder.</p>
        <p className="mt-1">
          {businessName} must publish a real privacy policy here before running
          ads at the opt-in page or submitting an A2P 10DLC campaign for carrier
          review. The policy must state, in substance and in these terms, that
          mobile opt-in data and consent will not be shared with third parties
          or affiliates for marketing purposes.
        </p>
      </div>

      <ul className="mt-6 list-disc space-y-1.5 pl-5 text-sm text-gray-600 dark:text-gray-400">
        <li>What is collected on the opt-in form and why.</li>
        <li>
          The mandatory clause: mobile opt-in data and consent are not shared
          with third parties or affiliates for marketing purposes.
        </li>
        <li>How to withdraw consent (reply STOP) and request deletion.</li>
        <li>Retention periods, including consent records kept five years.</li>
        <li>A contact address for privacy requests.</li>
      </ul>
    </div>
  );
}
