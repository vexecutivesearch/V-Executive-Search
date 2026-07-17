"use client";

import { useCallback, useState } from "react";
import { DemoModal } from "./DemoModal";
import { LandingSections } from "./LandingSections";
import { VillatoroHero3D } from "./VillatoroHero3D";
import "./landing.css";

export function LandingPage() {
  const [demoOpen, setDemoOpen] = useState(false);
  const [interests, setInterests] = useState<string[]>([]);

  const openDemo = useCallback((selected: string[] = []) => {
    setInterests(selected);
    setDemoOpen(true);
  }, []);

  const closeDemo = useCallback(() => setDemoOpen(false), []);

  return (
    <div className="landing">
      <VillatoroHero3D onBookDemo={openDemo} />
      <LandingSections onBookDemo={() => openDemo([])} />
      <DemoModal open={demoOpen} onClose={closeDemo} interests={interests} />
    </div>
  );
}
