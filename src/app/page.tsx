import type { Metadata } from "next";
import { LandingPage } from "@/components/landing/LandingPage";

export const metadata: Metadata = {
  title: "Villatoro Executive Search — Know who's hiring before anyone else",
  description:
    "The recruiting intelligence platform that scans your market every day, scores every hiring company, and hands you the decision-maker's direct line. Palm Beach–based executive search.",
};

export default function Home() {
  return <LandingPage />;
}
