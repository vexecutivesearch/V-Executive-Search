"use client";

/**
 * Villatoro hero — Harvv-inspired left/right editorial layout.
 * Keeps typewriter + interest pills + scrub video ambience.
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, ArrowRight } from "lucide-react";
import { CRM_URL, VIDEO_SRC } from "./constants";

function useTypewriter(text: string, speed = 34, startDelay = 400) {
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
    <div className="scrub-video" aria-hidden="true">
      <video ref={videoRef} src={VIDEO_SRC} muted playsInline preload="auto" />
    </div>
  );
}

function Navbar({ onBookDemo }: { onBookDemo: () => void }) {
  return (
    <nav className="landing-nav">
      <div className="wrap nav-in">
        <a className="logo" href="#top">
          <span className="logo-mark">V</span>
          <span className="logo-name">Villatoro</span>
        </a>
        <div className="nav-cta">
          <button type="button" className="nav-linkish" onClick={onBookDemo}>
            Book a demo
          </button>
          <a className="btn btn-primary" href={CRM_URL}>
            Try for free <span className="arrow">→</span>
          </a>
        </div>
      </div>
    </nav>
  );
}

function HeroStage() {
  return (
    <div className="stage">
      <div className="stage-glow" />
      <ScrubVideo />

      <motion.div
        className="case-card"
        initial={{ opacity: 0, y: 28, rotate: -2 }}
        animate={{ opacity: 1, y: 0, rotate: -1.2 }}
        transition={{ duration: 0.7, delay: 0.2 }}
      >
        <div className="case-top">
          <span className="case-label">villatoro://signal</span>
          <span className="case-badge">hot · live</span>
        </div>
        <div className="case-title">Same role reposted 8× in 21 days</div>
        <div className="case-meta">Menzies Aviation · Charlotte, NC · score 95</div>
        <p className="case-body">
          They&apos;ve been stuck hiring an Accounting Clerk for three weeks.{" "}
          <b>CEO found · verified mobile · iMessage ready.</b> Ranked #1 on today&apos;s
          call sheet.
        </p>
        <span className="case-action">⧉ open call sheet</span>
      </motion.div>

      <motion.div
        className="case-card"
        initial={{ opacity: 0, y: 36 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.35 }}
      >
        <div className="case-top">
          <span className="case-label">pipeline · ranked by ICP fit</span>
          <span className="case-badge" style={{ color: "var(--ok)", background: "var(--ok-sunk)", borderColor: "rgba(52,229,160,.28)" }}>
            475 hot
          </span>
        </div>
        <div className="pipe-mini" style={{ marginTop: 4, border: 0, background: "transparent" }}>
          <div className="pipe-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
            <span className="score-ring">92</span>
            <div className="pipe-co">
              <b>Alzheimer&apos;s Community Care</b>
              <small>West Palm Beach · Director of Nursing · CEO + HR</small>
            </div>
            <span className="pipe-cta">Call</span>
          </div>
          <div className="pipe-row" style={{ paddingLeft: 0, paddingRight: 0 }}>
            <span
              className="score-ring"
              style={{
                color: "var(--watch)",
                background: "var(--watch-sunk)",
                borderColor: "rgba(255,194,75,.3)",
              }}
            >
              84
            </span>
            <div className="pipe-co">
              <b>Palm Beach Ortho Group</b>
              <small>West Palm Beach · Practice Admin · HR found</small>
            </div>
            <span className="pipe-cta">Call</span>
          </div>
        </div>
      </motion.div>

      <p className="scrub-hint">↘ move your mouse — the stage scrubs the 3D scene live</p>
    </div>
  );
}

type VillatoroHero3DProps = {
  onBookDemo: (interests: string[]) => void;
};

export function VillatoroHero3D({ onBookDemo }: VillatoroHero3DProps) {
  const { displayed, done } = useTypewriter("Know who's hiring\nbefore anyone else.");
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

  // Emphasize trailing phrase once typed (Harvv dotted underline treatment)
  const renderHeadline = () => {
    const emphasis = "anyone else.";
    if (done && displayed.endsWith(emphasis)) {
      const idx = displayed.lastIndexOf(emphasis);
      return (
        <>
          {displayed.slice(0, idx)}
          <span className="em">{emphasis}</span>
        </>
      );
    }
    return (
      <>
        {displayed}
        {!done && (
          <span
            className="animate-blink"
            style={{
              display: "inline-block",
              width: 2,
              height: "0.9em",
              background: "var(--signal)",
              marginLeft: 2,
              verticalAlign: "middle",
            }}
          />
        )}
      </>
    );
  };

  return (
    <>
      <Navbar onBookDemo={() => onBookDemo(services)} />
      <header className="landing-hero" id="top">
        <div className="wrap hero-grid">
          <div>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <div className="chips">
                <span className="chip">Recruiting intel</span>
                <span className="chip">Nationwide</span>
                <span className="chip">Built by recruiters</span>
                <span className="chip">Palm Beach</span>
              </div>
              <h1>{renderHeadline()}</h1>
            </motion.div>

            <motion.p
              className="sub"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.08 }}
            >
              Our platform scans the job market every morning, scores every company on how
              badly they need help, and hands you the{" "}
              <b>decision-maker&apos;s direct line</b> — so you spend your day in
              conversations, not research.
            </motion.p>

            <motion.div
              className="hero-cta"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.14 }}
            >
              <a className="btn btn-primary" href={CRM_URL}>
                Try for free <span className="arrow">→</span>
              </a>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => onBookDemo(services)}
              >
                Book a demo <span className="arrow">→</span>
              </button>
            </motion.div>
            <p className="note">
              Live nationwide — every state, every major metro · no credit card required
            </p>

            <motion.div
              className="solve"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.22 }}
            >
              <h2>What are you looking to solve?</h2>
              <p className="hint">Select all that apply</p>
              <div className="pills">
                {options.map((opt) => {
                  const active = services.includes(opt);
                  return (
                    <motion.button
                      key={opt}
                      type="button"
                      className={`pill-btn${active ? " active" : ""}`}
                      onClick={() => toggle(opt)}
                      whileTap={{ scale: 0.97 }}
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
                            <Check size={14} />
                          </motion.span>
                        )}
                      </AnimatePresence>
                      {opt}
                    </motion.button>
                  );
                })}
              </div>
              <div className="ready">
                <AnimatePresence mode="wait">
                  {services.length === 0 ? (
                    <motion.p
                      key="empty"
                      className="ready-empty"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 0.7 }}
                      exit={{ opacity: 0 }}
                    >
                      Click to select what you&apos;d like to see above.
                    </motion.p>
                  ) : (
                    <motion.div
                      key="selected"
                      className="ready-banner"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                    >
                      <span>
                        Ready to see: <b>{services.join(", ")}</b>
                      </span>
                      <button type="button" onClick={() => onBookDemo(services)}>
                        Let&apos;s go <ArrowRight size={13} />
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          </div>

          <HeroStage />
        </div>
      </header>
    </>
  );
}
