"use client";

import { CRM_URL, DISPLAY_EMAIL } from "./constants";

type LandingSectionsProps = {
  onBookDemo: () => void;
};

export function LandingSections({ onBookDemo }: LandingSectionsProps) {
  return (
    <>
      <div className="wrap">
        <div className="stats">
          <div className="stat">
            <div className="n">15,000+</div>
            <div className="d">job listings scanned daily</div>
          </div>
          <div className="stat">
            <div className="n">50</div>
            <div className="d">states — live nationwide</div>
          </div>
          <div className="stat">
            <div className="n">4</div>
            <div className="d">job boards monitored</div>
          </div>
          <div className="stat">
            <div className="n">6 AM</div>
            <div className="d">your ranked call sheet, daily</div>
          </div>
        </div>
      </div>

      <section className="wrap" id="platform">
        <span className="kicker">Why this matters</span>
        <h2>
          Most tools find candidates. Ours finds you{" "}
          <span className="em">clients</span>.
        </h2>
        <p className="lead">
          From 15,000 job posts to the 10 calls that matter — companies struggling to hire
          right now, scored and ranked before you pour your first coffee.
        </p>
        <div className="features">
          <div className="feature">
            <div
              className="ic"
              style={{
                background: "var(--alert-sunk)",
                border: "1px solid rgba(255,107,115,.3)",
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--alert)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 23c4.4 0 7-2.9 7-6.4 0-4-3.4-6-3.9-9.6-2 2.5-3 3.6-4 5-1-1-1.4-2-1.4-3C6.6 11 5 13 5 16.6 5 20.1 7.6 23 12 23z" />
              </svg>
            </div>
            <div>
              <h3>Hiring-pain radar</h3>
              <p>
                We scan Indeed, LinkedIn, Google Jobs and more every morning across your
                markets. A role reposted 8 times in 21 days isn&apos;t a listing — it&apos;s a
                company that needs you. We flag it before your competitors notice.
              </p>
              <span className="tag">475 hot signals live right now</span>
            </div>
          </div>
          <div className="feature">
            <div
              className="ic"
              style={{
                background: "var(--signal-sunk)",
                border: "1px solid rgba(110,123,255,.35)",
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--signal-hi)"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="5" />
                <circle cx="12" cy="12" r="1.5" fill="var(--signal-hi)" />
              </svg>
            </div>
            <div>
              <h3>Decision-makers, not gatekeepers</h3>
              <p>
                For every hot company, the platform finds the owner, managing partner, or HR
                director — with verified email, direct mobile, and even whether their number
                takes iMessage. You reach the person who signs, not the front desk.
              </p>
              <span className="tag">Verified contact channels</span>
            </div>
          </div>
          <div className="feature">
            <div
              className="ic"
              style={{
                background: "var(--ok-sunk)",
                border: "1px solid rgba(52,229,160,.3)",
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--ok)"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M6.6 10.8c1.5 2.9 3.7 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1l-2.3 2.2z" />
              </svg>
            </div>
            <div>
              <h3>A CRM built around the call</h3>
              <p>
                ICP scoring surfaces mid-size private companies that actually use outside
                recruiters — and sinks the Fortune 500s, hospitals and government agencies
                you&apos;ll never win. One click adds a lead to your call list with statuses,
                follow-ups and notes.
              </p>
              <span className="tag">ICP fit scoring 0–100</span>
            </div>
          </div>
        </div>
      </section>

      <section className="wrap" id="how">
        <span className="kicker">How it works</span>
        <h2>Your night shift works while you sleep.</h2>
        <p className="lead">
          One pipeline. No dashboard sprawl. Wake up to who to call, why now, and how to open.
        </p>
        <div className="steps">
          <div className="step">
            <div className="num">01</div>
            <h3>Overnight market scan</h3>
            <p>
              Every evening the platform sweeps your active markets — every board, every
              posting, every repost — and scores each company on hiring urgency and
              recruiter fit.
            </p>
          </div>
          <div className="step">
            <div className="num">02</div>
            <h3>Decision-maker lookup</h3>
            <p>
              For the top-ranked companies, it finds the right contact for the firm&apos;s
              size and sector — managing partner at a small law firm, HR director at a
              mid-market company — with verified channels.
            </p>
          </div>
          <div className="step">
            <div className="num">03</div>
            <h3>Your 6 AM call sheet</h3>
            <p>
              You wake up to a ranked list: who to call, why now, and a suggested opener
              referencing their exact hiring pain. Work it top-down. That&apos;s the whole
              job.
            </p>
          </div>
        </div>
      </section>

      <section className="wrap" id="firm">
        <span className="kicker">The firm behind the platform</span>
        <h2>Software built by a search firm, not a software company.</h2>
        <div className="firm">
          <div>
            <p className="lead" style={{ marginBottom: 0 }}>
              Villatoro Executive Search is a Palm Beach–based recruiting firm serving
              growing organizations nationwide. We built this platform for our own desk
              first — every feature exists because a recruiter needed it on a real call day.
              Direct hire, contract staffing, and workforce solutions, powered by the same
              intelligence you see here.
            </p>
            <div className="industries">
              {[
                "Legal",
                "Finance & Accounting",
                "Technology & IT",
                "Medical & Healthcare",
                "Sales & BD",
                "Marketing & Creative",
                "Construction",
                "Skilled Trades",
                "Startups",
              ].map((label) => (
                <span key={label} className="ind">
                  {label}
                </span>
              ))}
            </div>
          </div>
          <div className="quote">
            <div className="stars" aria-label="5 stars">
              <svg width="90" height="15" viewBox="0 0 90 15" fill="#ffc24b">
                <path d="M7.5 0l2.1 4.6 5 .6-3.7 3.4 1 4.9-4.4-2.5-4.4 2.5 1-4.9L.4 5.2l5-.6z" />
                <path d="M25.5 0l2.1 4.6 5 .6-3.7 3.4 1 4.9-4.4-2.5-4.4 2.5 1-4.9-3.7-3.4 5-.6z" />
                <path d="M43.5 0l2.1 4.6 5 .6-3.7 3.4 1 4.9-4.4-2.5-4.4 2.5 1-4.9-3.7-3.4 5-.6z" />
                <path d="M61.5 0l2.1 4.6 5 .6-3.7 3.4 1 4.9-4.4-2.5-4.4 2.5 1-4.9-3.7-3.4 5-.6z" />
                <path d="M79.5 0l2.1 4.6 5 .6-3.7 3.4 1 4.9-4.4-2.5-4.4 2.5 1-4.9-3.7-3.4 5-.6z" />
              </svg>
            </div>
            &ldquo;We partner with growing organizations to identify, attract, and place
            talent that drives long-term impact. Fast, strategic, relationship-driven
            recruiting — built for long-term success.&rdquo;
            <div className="who">
              <span className="avatar">AD</span>
              <span>
                <b>Alejandro O. Delgado</b>
                <span>Head of Client Services</span>
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="wrap" id="faq">
        <span className="kicker">Common questions</span>
        <h2>What people ask before trying it.</h2>
        <div className="faq-grid">
          <div className="faq-item">
            <h3>Who is this platform for?</h3>
            <p>
              Recruiting firm owners and BD-focused recruiters who want to know which
              companies in their market are struggling to hire — before those companies post
              on a job board for the ninth time.
            </p>
          </div>
          <div className="faq-item">
            <h3>How is this different from a candidate-sourcing tool?</h3>
            <p>
              Sourcing tools find you candidates. We find you clients — ranked companies
              likely to engage an outside recruiter, with the decision-maker&apos;s direct
              contact attached.
            </p>
          </div>
          <div className="faq-item">
            <h3>Which markets do you cover?</h3>
            <p>
              Live nationwide — every state and every major metro. Cross-state metros are
              handled correctly, and niche markets can be tuned to your book of business.
            </p>
          </div>
          <div className="faq-item">
            <h3>Where does the contact data come from?</h3>
            <p>
              Licensed enrichment providers. Contacts are matched by company and title, with
              verification flags for email, direct mobile, and location match.
            </p>
          </div>
          <div className="faq-item">
            <h3>Can I try it before booking a demo?</h3>
            <p>
              Yes — Try for free opens the live Pipeline. When you want it tuned to your
              markets, book a demo and we&apos;ll set it up together.
            </p>
          </div>
          <div className="faq-item">
            <h3>Do I need a credit card?</h3>
            <p>
              No. Try the platform free with no card. Book a demo when you&apos;re ready to
              tune markets and niches for your desk.
            </p>
          </div>
        </div>
      </section>

      <section className="final wrap">
        <span className="kicker">Ready when you are</span>
        <h2>
          Your market is hiring.
          <br />
          Be the <span className="em">first call</span> they get.
        </h2>
        <p>Try the live platform now, or book 20 minutes and we&apos;ll walk you through it.</p>
        <div className="hero-cta">
          <a className="btn btn-primary" href={CRM_URL}>
            Try for free <span className="arrow">→</span>
          </a>
          <button type="button" className="btn btn-ghost" onClick={onBookDemo}>
            Book a demo <span className="arrow">→</span>
          </button>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="wrap foot">
          <div>
            <b>Villatoro Executive Search</b>
            <br />
            Palm Beach, FL · Nationwide &amp; select international searches
            <br />
            (561) 401-8355 · {DISPLAY_EMAIL}
          </div>
          <div className="nav-cta">
            <button type="button" className="btn btn-ghost" onClick={onBookDemo}>
              Book a demo
            </button>
            <a className="btn btn-primary" href={CRM_URL}>
              Try for free <span className="arrow">→</span>
            </a>
          </div>
        </div>
        <div className="wrap" style={{ marginTop: 22 }}>
          © 2026 Villatoro Executive Search. All rights reserved.
        </div>
      </footer>
    </>
  );
}
