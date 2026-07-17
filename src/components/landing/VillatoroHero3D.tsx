"use client";

/**
 * VillatoroHero3D — interactive 3D-motion hero for the Villatoro platform landing page.
 * Stack: React + Tailwind CSS + Framer Motion (motion/react) + lucide-react.
 * Palette remapped to dark-glass landing tokens (bg #0a0d17, accent #6c8bff).
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, ArrowRight } from "lucide-react";
import { CRM_URL, VIDEO_SRC } from "./constants";

/* ── Typewriter hook ──────────────────────────────────────────────────────── */
function useTypewriter(text: string, speed = 38, startDelay = 600) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      let i = 0;
      interval = setInterval(() => {
        i += 1;
        setDisplayed(text.slice(0, i));
        if (i >= text.length) {
          clearInterval(interval);
          setDone(true);
        }
      }, speed);
    }, startDelay);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [text, speed, startDelay]);

  return { displayed, done };
}

/* ── Background video with native mouse scrubbing ─────────────────────────── */
function ScrubVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const prevX = useRef<number | null>(null);
  const target = useRef(0);
  const seeking = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onSeeked = () => {
      seeking.current = false;
      if (Math.abs(video.currentTime - target.current) > 0.02) {
        seeking.current = true;
        video.currentTime = target.current;
      }
    };

    const onMove = (e: MouseEvent) => {
      if (window.innerWidth < 1024) return;
      if (!video.duration) return;
      if (prevX.current === null) {
        prevX.current = e.clientX;
        return;
      }
      const delta = e.clientX - prevX.current;
      prevX.current = e.clientX;
      target.current = Math.min(
        Math.max(target.current + (delta / window.innerWidth) * 0.8 * video.duration, 0),
        video.duration,
      );
      if (!seeking.current) {
        seeking.current = true;
        video.currentTime = target.current;
      }
    };

    video.addEventListener("seeked", onSeeked);
    window.addEventListener("mousemove", onMove);
    return () => {
      video.removeEventListener("seeked", onSeeked);
      window.removeEventListener("mousemove", onMove);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (window.innerWidth < 1024) {
      video.autoplay = true;
      video.loop = true;
      video.play().catch(() => {});
    }
  }, []);

  return (
    <div className="order-last lg:order-none relative lg:absolute lg:inset-0 lg:z-0 overflow-hidden pointer-events-none w-full aspect-square md:aspect-video lg:aspect-auto lg:h-full bg-[#0e1220]/80 lg:bg-transparent">
      <video
        ref={videoRef}
        src={VIDEO_SRC}
        muted
        playsInline
        preload="auto"
        className="w-full h-full object-cover object-right lg:object-right-bottom opacity-70 lg:opacity-55"
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "linear-gradient(90deg, rgba(10,13,23,.92) 0%, rgba(10,13,23,.55) 45%, rgba(10,13,23,.15) 100%)",
        }}
        aria-hidden="true"
      />
    </div>
  );
}

/* ── Navbar ───────────────────────────────────────────────────────────────── */
function Navbar({ onBookDemo }: { onBookDemo: () => void }) {
  const [isMobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <>
      <header className="fixed top-0 inset-x-0 z-20 px-5 sm:px-8 py-4 sm:py-5 flex flex-row justify-between items-center bg-[rgba(10,13,23,.72)] backdrop-blur-xl border-b border-white/[0.06]">
        <a href="#top" className="flex flex-row items-center gap-2.5">
          <span className="w-7 h-7 rounded-lg bg-white text-[#0a0d17] flex items-center justify-center font-extrabold text-base select-none">
            V
          </span>
          <span className="leading-none">
            <span className="block text-[13px] tracking-[0.08em] font-bold text-[#f4f6fc]">
              VILLATORO
            </span>
            <span className="block text-[9px] tracking-[0.16em] text-[#8b93ab] mt-[-2px]">
              EXECUTIVE SEARCH
            </span>
          </span>
        </a>

        <div className="hidden md:flex items-center gap-3">
          <button type="button" onClick={onBookDemo} className="btn btn-ghost">
            Book a demo
          </button>
          <a href={CRM_URL} className="btn btn-primary">
            Try for free
          </a>
        </div>

        <button
          type="button"
          aria-label="Menu"
          onClick={() => setMobileMenuOpen((v) => !v)}
          className="md:hidden flex flex-col gap-[5px] p-2"
        >
          <span
            className={`w-6 h-[2px] bg-[#f4f6fc] transition-all duration-300 ${
              isMobileMenuOpen ? "rotate-45 translate-y-[7px]" : ""
            }`}
          />
          <span
            className={`w-6 h-[2px] bg-[#f4f6fc] transition-all duration-300 ${
              isMobileMenuOpen ? "opacity-0" : ""
            }`}
          />
          <span
            className={`w-6 h-[2px] bg-[#f4f6fc] transition-all duration-300 ${
              isMobileMenuOpen ? "-rotate-45 -translate-y-[7px]" : ""
            }`}
          />
        </button>
      </header>

      <div
        className={`md:hidden fixed inset-0 z-[19] bg-[rgba(10,13,23,.96)] backdrop-blur-sm transition-opacity duration-300 flex flex-col items-center justify-center gap-6 text-xl ${
          isMobileMenuOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        <button
          type="button"
          onClick={() => {
            setMobileMenuOpen(false);
            onBookDemo();
          }}
          className="btn btn-ghost"
        >
          Book a demo
        </button>
        <a
          href={CRM_URL}
          onClick={() => setMobileMenuOpen(false)}
          className="btn btn-primary"
        >
          Try for free
        </a>
      </div>
    </>
  );
}

type VillatoroHero3DProps = {
  onBookDemo: (interests: string[]) => void;
};

/* ── Hero ─────────────────────────────────────────────────────────────────── */
export function VillatoroHero3D({ onBookDemo }: VillatoroHero3DProps) {
  const { displayed, done } = useTypewriter("know who's hiring\nbefore anyone else.");
  const [services, setServices] = useState<string[]>([]);
  const options = [
    "Client prospecting",
    "Decision-maker contacts",
    "Call list CRM",
    "New markets",
  ];

  const toggle = (opt: string) =>
    setServices((prev) =>
      prev.includes(opt) ? prev.filter((s) => s !== opt) : [...prev, opt],
    );

  return (
    <div
      id="top"
      className="relative text-[#f4f6fc] antialiased overflow-x-hidden flex flex-col lg:block lg:min-h-screen"
    >
      <Navbar onBookDemo={() => onBookDemo(services)} />
      <ScrubVideo />

      <div className="relative z-10 flex flex-col order-first lg:order-none w-full bg-transparent pb-8 lg:pb-0 lg:min-h-screen">
        <main
          id="spade-hero"
          className="w-full max-w-7xl mx-auto px-6 pt-28 pb-12 flex-1 flex flex-col justify-center"
        >
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <span className="inline-block text-xs font-semibold text-[#6c8bff] bg-[rgba(108,139,255,.22)] border border-[rgba(108,139,255,.4)] px-3.5 py-1.5 rounded-full mb-5">
              Palm Beach–based · Recruiting intelligence, built by recruiters
            </span>
            <h1 className="text-5xl md:text-6xl lg:text-[60px] font-extrabold tracking-tight text-[#f4f6fc] leading-[1.08] mb-6 select-none w-full whitespace-pre-wrap">
              {displayed}
              {!done && (
                <span className="inline-block w-[2px] h-[1.1em] bg-[#6c8bff] align-middle ml-[2px] animate-blink" />
              )}
            </h1>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            <p className="text-lg md:text-[17px] text-[#aeb6cc] leading-relaxed font-normal mb-8 max-w-2xl">
              Our platform scans the job market every morning, scores every company on how
              badly they need help, and hands you the decision-maker&apos;s direct line —
              so you spend your day in conversations, not research.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.18 }}
            className="flex flex-wrap gap-3 mb-4"
          >
            <a href={CRM_URL} className="btn btn-primary">
              Try for free
            </a>
            <button
              type="button"
              onClick={() => onBookDemo(services)}
              className="btn btn-ghost"
            >
              Book a demo
            </button>
          </motion.div>
          <p className="text-xs text-[#7e8aa6] mb-12">
            Live nationwide — every state, every major metro · no credit card required
          </p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.25 }}
          >
            <h2 className="text-2xl font-semibold tracking-tight mb-2 !mt-0">
              What are you looking to solve?
            </h2>
            <p className="text-[#8b93ab] mb-6 text-sm">Select all that apply</p>

            <div className="flex flex-wrap gap-3">
              {options.map((opt) => {
                const active = services.includes(opt);
                return (
                  <motion.button
                    key={opt}
                    type="button"
                    onClick={() => toggle(opt)}
                    whileTap={{ scale: 0.96 }}
                    className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-[15px] font-medium transition-colors border ${
                      active
                        ? "bg-[#6c8bff] text-white border-[rgba(108,139,255,.5)] shadow-[0_6px_24px_rgba(108,139,255,.35)]"
                        : "bg-white/[0.05] text-[#f4f6fc] border-white/[0.09] hover:bg-white/[0.09]"
                    }`}
                  >
                    <AnimatePresence>
                      {active && (
                        <motion.span
                          initial={{ scale: 0, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0, opacity: 0 }}
                          transition={{ type: "spring", stiffness: 300, damping: 20 }}
                          className="flex"
                        >
                          <Check size={15} />
                        </motion.span>
                      )}
                    </AnimatePresence>
                    {opt}
                  </motion.button>
                );
              })}
            </div>

            <div className="mt-6 min-h-[52px]">
              <AnimatePresence mode="wait">
                {services.length === 0 ? (
                  <motion.p
                    key="empty"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 0.55 }}
                    exit={{ opacity: 0 }}
                    className="italic text-xs text-[#8b93ab]"
                  >
                    Please click to select what you&apos;d like to see above.
                  </motion.p>
                ) : (
                  <motion.div
                    key="selected"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ type: "spring", stiffness: 260, damping: 26 }}
                    className="overflow-hidden"
                  >
                    <div className="flex items-center justify-between gap-4 bg-white/[0.05] border border-white/[0.09] rounded-2xl px-5 py-4">
                      <span className="text-sm text-[#f4f6fc]">
                        Ready to see: <b>{services.join(", ")}</b>
                      </span>
                      <button
                        type="button"
                        onClick={() => onBookDemo(services)}
                        className="flex items-center gap-1.5 text-[#6c8bff] uppercase text-xs font-semibold tracking-wide hover:opacity-70 transition-opacity"
                      >
                        Let&apos;s go <ArrowRight size={14} />
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        </main>
      </div>
    </div>
  );
}
