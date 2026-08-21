import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Thanks" };

/** Landing target for a no-JavaScript form post. */
export default function OptInThanksPage() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-bold">Thanks — we have your details.</h1>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
        A recruiter will be in touch shortly about the role you are hiring for.
      </p>
      <p className="mt-6 text-sm">
        <Link href="/opt-in" className="underline">
          Submit another role
        </Link>
      </p>
    </div>
  );
}
