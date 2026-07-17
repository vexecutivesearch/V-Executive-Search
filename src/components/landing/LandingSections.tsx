"use client";

import { CRM_URL, DISPLAY_EMAIL } from "./constants";

type LandingSectionsProps = {
  onBookDemo: () => void;
};

export function ProductShot() {
  return (
    <div className="wrap" style={{ paddingBottom: 10 }}>
      <div className="shot">
        <div className="shot-bar">
          <span className="dot" style={{ background: "#f0655a" }} />
          <span className="dot" style={{ background: "#f5be4f" }} />
          <span className="dot" style={{ background: "#61c554" }} />
        </div>
        <div className="shot-head">
          <div>
            <div className="shot-title">Pipeline</div>
            <div className="shot-sub">All markets · all dates · ranked by ICP fit</div>
          </div>
          <span
            className="pill"
            style={{
              color: "#ffb38f",
              background: "rgba(255,140,90,.14)",
              border: "1px solid rgba(255,140,90,.28)",
            }}
          >
            475 hot signals
          </span>
        </div>
        <div className="kpis">
          <div className="kpi">
            <div className="l">COMPANIES TRACKED</div>
            <div className="v">2,757</div>
          </div>
          <div className="kpi">
            <div className="l">DECISION-MAKERS FOUND</div>
            <div className="v">1,204</div>
          </div>
          <div className="kpi">
            <div className="l">STATES LIVE</div>
            <div className="v">50</div>
          </div>
        </div>
        <div className="rows">
          <div className="row">
            <span
              className="score"
              style={{
                color: "#5ee0a8",
                background: "rgba(94,224,168,.13)",
                border: "1px solid rgba(94,224,168,.3)",
              }}
            >
              95
            </span>
            <div className="co">
              <b>Menzies Aviation</b>{" "}
              <span
                className="pill"
                style={{
                  color: "#9db4ff",
                  background: "rgba(108,139,255,.14)",
                  border: "1px solid rgba(108,139,255,.3)",
                }}
              >
                Charlotte, NC
              </span>{" "}
              <span
                className="pill"
                style={{ color: "#ffb38f", background: "rgba(255,140,90,.14)" }}
              >
                reposted 8×
              </span>
              <small>Accounting Clerk · CEO found · iMessage ✓</small>
            </div>
            <span className="cta-mini">Call sheet</span>
          </div>
          <div className="row">
            <span
              className="score"
              style={{
                color: "#5ee0a8",
                background: "rgba(94,224,168,.13)",
                border: "1px solid rgba(94,224,168,.3)",
              }}
            >
              92
            </span>
            <div className="co">
              <b>Alzheimer&apos;s Community Care</b>{" "}
              <span
                className="pill"
                style={{
                  color: "#7be0c3",
                  background: "rgba(15,169,138,.16)",
                  border: "1px solid rgba(15,169,138,.32)",
                }}
              >
                West Palm Beach, FL
              </span>
              <small>Director of Nursing · CEO + HR found · verified mobile</small>
            </div>
            <span className="cta-mini">Call sheet</span>
          </div>
          <div className="row">
            <span
              className="score"
              style={{
                color: "#f5be4f",
                background: "rgba(245,190,79,.12)",
                border: "1px solid rgba(245,190,79,.3)",
              }}
            >
              84
            </span>
            <div className="co">
              <b>Palm Beach Ortho Group</b>{" "}
              <span
                className="pill"
                style={{
                  color: "#7be0c3",
                  background: "rgba(15,169,138,.16)",
                  border: "1px solid rgba(15,169,138,.32)",
                }}
              >
                West Palm Beach, FL
              </span>
              <small>Practice Administrator · HR Manager found</small>
            </div>
            <span className="cta-mini">Call sheet</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandingSections({ onBookDemo }: LandingSectionsProps) {
  return (
    <>
      <ProductShot />

      <div className="wrap stats">
        <div className="stat glass">
          <div className="n">15,000+</div>
          <div className="d">job listings scanned daily</div>
        </div>
        <div className="stat glass">
          <div className="n">50</div>
          <div className="d">states — live nationwide</div>
        </div>
        <div className="stat glass">
          <div className="n">4</div>
          <div className="d">job boards monitored</div>
        </div>
        <div className="stat glass">
          <div className="n">6 AM</div>
          <div className="d">your ranked call sheet, daily</div>
        </div>
      </div>

      <section className="wrap" id="platform">
        <span className="kicker">[01] The platform</span>
        <h2>From 15,000 job posts to the 10 calls that matter.</h2>
        <p className="lead">
          Most recruiting tools help you find candidates. Ours finds you{" "}
          <b style={{ color: "var(--ink)" }}>clients</b> — the companies struggling to hire
          right now, scored and ranked before you pour your first coffee.
        </p>
        <div className="features">
          <div className="feature glass">
            <div
              className="ic"
              style={{
                background: "rgba(255,140,90,.14)",
                border: "1px solid rgba(255,140,90,.3)",
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#ff8f6b"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 23c4.4 0 7-2.9 7-6.4 0-4-3.4-6-3.9-9.6-2 2.5-3 3.6-4 5-1-1-1.4-2-1.4-3C6.6 11 5 13 5 16.6 5 20.1 7.6 23 12 23z" />
              </svg>
            </div>
            <h3>Hiring-pain radar</h3>
            <p>
              We scan Indeed, LinkedIn, Google Jobs and more every morning across your
              markets. A role reposted 8 times in 21 days isn&apos;t a listing — it&apos;s a
              company that needs you. We flag it before your competitors notice.
            </p>
            <span className="tag">475 hot signals live right now</span>
          </div>
          <div className="feature glass">
            <div
              className="ic"
              style={{
                background: "rgba(108,139,255,.14)",
                border: "1px solid rgba(108,139,255,.3)",
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#6c8bff"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="5" />
                <circle cx="12" cy="12" r="1.5" fill="#6c8bff" />
              </svg>
            </div>
            <h3>Decision-makers, not gatekeepers</h3>
            <p>
              For every hot company, the platform finds the owner, managing partner, or HR
              director — with verified email, direct mobile, and even whether their number
              takes iMessage. You reach the person who signs, not the front desk.
            </p>
            <span className="tag">Verified contact channels</span>
          </div>
          <div className="feature glass">
            <div
              className="ic"
              style={{
                background: "rgba(94,224,168,.14)",
                border: "1px solid rgba(94,224,168,.3)",
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#5ee0a8"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M6.6 10.8c1.5 2.9 3.7 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1l-2.3 2.2z" />
              </svg>
            </div>
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
      </section>

      <section className="wrap" id="how">
        <span className="kicker">[02] How it works</span>
        <h2>Your night shift works while you sleep.</h2>
        <div className="steps">
          <div className="step glass">
            <div className="num">1</div>
            <h3>Overnight market scan</h3>
            <p>
              Every evening the platform sweeps your active markets — every board, every
              posting, every repost — and scores each company on hiring urgency and
              recruiter fit.
            </p>
          </div>
          <div className="step glass">
            <div className="num">2</div>
            <h3>Decision-maker lookup</h3>
            <p>
              For the top-ranked companies, it finds the right contact for the firm&apos;s
              size and sector — managing partner at a small law firm, HR director at a
              mid-market company — with verified channels.
            </p>
          </div>
          <div className="step glass">
            <div className="num">3</div>
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
        <span className="kicker">[03] The firm behind the platform</span>
        <h2>Software built by a search firm, not a software company.</h2>
        <div className="firm" style={{ marginTop: 30 }}>
          <div>
            <p className="lead" style={{ marginBottom: 18 }}>
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
          <div className="quote glass">
            <div className="stars" aria-label="5 stars">
              <svg width="90" height="15" viewBox="0 0 90 15" fill="#c9b98a">
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
        <span className="kicker">[04] FAQ</span>
        <h2>Your questions, answered.</h2>
        <div style={{ maxWidth: 720, marginTop: 26 }}>
          <details>
            <summary>Who is this platform for?</summary>
            <div className="a">
              Recruiting firm owners and business-development-focused recruiters who want to
              know which companies in their market are struggling to hire — before those
              companies post on a job board for the ninth time. If you sell recruiting
              services, this is your prospecting engine.
            </div>
          </details>
          <details>
            <summary>How is this different from a candidate-sourcing tool?</summary>
            <div className="a">
              Sourcing tools find you candidates. We find you clients. The platform watches
              employer behavior — reposts, hiring clusters, long-open roles — and turns it
              into a ranked list of companies likely to engage an outside recruiter, with the
              decision-maker&apos;s direct contact attached.
            </div>
          </details>
          <details>
            <summary>Which markets do you cover?</summary>
            <div className="a">
              We&apos;re live nationwide — every state and every major metro. Cross-state
              metros (like Charlotte, NC including Rock Hill, SC) are handled correctly, and
              additional niche markets can be tuned to your book of business on request.
            </div>
          </details>
          <details>
            <summary>Where does the contact data come from?</summary>
            <div className="a">
              Licensed, industry-standard enrichment providers. Contacts are matched by
              company and title, with verification flags for email deliverability, direct
              mobile, and location match — so you know exactly how solid a channel is before
              you use it.
            </div>
          </details>
          <details>
            <summary>Can I try it before booking a demo?</summary>
            <div className="a">
              Yes — the &ldquo;Try for free&rdquo; button opens the live platform. Poke
              around the pipeline, the hot signals, and the call list. When you want it tuned
              to your markets and niches, book a demo and we&apos;ll set it up together.
            </div>
          </details>
        </div>
      </section>

      <section className="final wrap">
        <span className="kicker">Ready when you are</span>
        <h2>
          Your market is hiring.
          <br />
          Be the first call they get.
        </h2>
        <p>Try the live platform now, or book 20 minutes and we&apos;ll walk you through it.</p>
        <div className="hero-cta">
          <a className="btn btn-primary" href={CRM_URL}>
            Try for free
          </a>
          <button type="button" className="btn btn-ghost" onClick={onBookDemo}>
            Book a demo
          </button>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="wrap foot">
          <div>
            <b style={{ color: "var(--ink)" }}>VILLATORO EXECUTIVE SEARCH</b>
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
              Try for free
            </a>
          </div>
        </div>
        <div className="wrap" style={{ marginTop: 22, color: "var(--dim)" }}>
          © 2026 Villatoro Executive Search. All rights reserved.
        </div>
      </footer>
    </>
  );
}
