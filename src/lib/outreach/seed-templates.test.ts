import { describe, expect, it } from "vitest";
import { REPLY_TEMPLATE_KINDS } from "@/lib/outreach/reply-playbook";
import { sanitizeOutreachBody, sanitizeSubject } from "@/lib/outreach/sanitizer";
import {
  resolveSchedulingLink,
  schedulingCallLength,
} from "@/lib/outreach/scheduling-link";
import { SEED_TEMPLATES } from "@/lib/outreach/seed-templates";
import { templateKindLabel } from "@/lib/outreach/template-labels";

describe("seeded reply exemplars", () => {
  it("covers every reply kind on both channels", () => {
    for (const kind of REPLY_TEMPLATE_KINDS) {
      for (const channel of ["email", "imessage"] as const) {
        expect(
          SEED_TEMPLATES.some((t) => t.kind === kind && t.channel === channel),
          `missing a ${channel} exemplar for ${kind}`,
        ).toBe(true);
      }
    }
  });

  it("writes text replies that survive the sanitizer", () => {
    const texts = SEED_TEMPLATES.filter(
      (t) =>
        t.channel === "imessage" &&
        (REPLY_TEMPLATE_KINDS as readonly string[]).includes(t.kind),
    );
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      const result = sanitizeOutreachBody(t.exampleBody, {
        channel: "imessage",
        allowLinks: true,
      });
      expect(result.violations, `${t.name}: ${result.violations.join("; ")}`).toEqual(
        [],
      );
    }
  });

  it("puts the scheduling link in the positive text exemplar", () => {
    const positive = SEED_TEMPLATES.find(
      (t) => t.kind === "reply_positive" && t.channel === "imessage",
    );
    expect(positive?.exampleBody).toContain(
      "https://calendly.com/odv-vexecutivesearch/15m",
    );
  });

  it("shows the same link in both positive exemplars as the replies send", () => {
    const positives = SEED_TEMPLATES.filter((t) => t.kind === "reply_positive");
    expect(positives).toHaveLength(2);
    for (const t of positives) {
      expect(t.exampleBody, t.name).toContain(resolveSchedulingLink());
    }
  });

  it("never invites a call length the booking link does not offer", () => {
    // A link swap from a 30 minute event type to a 15 minute one used to leave
    // "grab any 30 min" sitting directly above the new URL.
    const linkMinutes = Number(schedulingCallLength()?.match(/\d+/)?.[0]);
    for (const t of SEED_TEMPLATES) {
      for (const match of t.exampleBody.matchAll(
        /(\d+)\s*(?:min|mins|minute|minutes)\b/gi,
      )) {
        expect(Number(match[1]), `${t.name} offers ${match[0]}`).toBe(
          linkMinutes,
        );
      }
    }
  });

  /*
   * Cold copy has a stricter lint than a reply: no links at all, and the dash
   * rule applies to the whole body rather than to everything outside a URL.
   */
  it("writes cold exemplars that survive the link-free sanitizer", () => {
    const cold = SEED_TEMPLATES.filter(
      (t) => !(REPLY_TEMPLATE_KINDS as readonly string[]).includes(t.kind),
    );
    expect(cold.length).toBeGreaterThan(0);
    for (const t of cold) {
      const result = sanitizeOutreachBody(t.exampleBody, {
        channel: t.channel,
      });
      expect(
        result.violations,
        `${t.name}: ${result.violations.join("; ")}`,
      ).toEqual([]);
      if (t.exampleSubject) {
        const subject = sanitizeSubject(t.exampleSubject);
        expect(
          subject.violations,
          `${t.name} subject: ${subject.violations.join("; ")}`,
        ).toEqual([]);
      }
    }
  });

  it("keeps every seeded name and body free of dashes outside URLs", () => {
    const dash = /[\u002D\u2010-\u2015\u2212]/;
    for (const t of SEED_TEMPLATES) {
      expect(dash.test(t.name), `dash in name: ${t.name}`).toBe(false);
      const withoutUrls = t.exampleBody.replace(/https?:\/\/\S+/gi, " ");
      expect(dash.test(withoutUrls), `dash in body: ${t.name}`).toBe(false);
      if (t.exampleSubject) {
        expect(dash.test(t.exampleSubject), `dash in subject: ${t.name}`).toBe(
          false,
        );
      }
    }
  });
});

/**
 * The first follow-up took 135 sends to zero replies. It restated that an
 * earlier email existed, offered empathy that fitted any company alive, sold
 * the process, and re-asked for the call the intro had already been refused.
 * Since exemplars are the style DNA every generated followup_1 is written
 * against, the exemplar is the fix.
 */
describe("the first follow-up exemplar", () => {
  const followup = SEED_TEMPLATES.find((t) => t.kind === "followup_1")!;

  it("passes the dash lint the drafts are held to", () => {
    const result = sanitizeOutreachBody(followup.exampleBody, {
      channel: "email",
    });
    expect(result.ok, result.violations.join("; ")).toBe(true);
    expect(
      result.violations.filter((v) => v.includes("dash or hyphen")),
    ).toEqual([]);
    expect(sanitizeSubject(followup.exampleSubject!).ok).toBe(true);
  });

  it("anchors on a hiring signal the pipeline actually collects", () => {
    const body = followup.exampleBody.toLowerCase();
    // The role title, the days it has been open, and the repost: all three
    // come off the job listing and the hiring signals we already store.
    expect(body).toContain("senior scada controls systems engineer");
    expect(body).toMatch(/\b\d+ days old\b/);
    expect(body).toContain("went back up on the board");
  });

  it("asks one low friction question instead of the call that already failed", () => {
    const body = followup.exampleBody.toLowerCase();
    expect(body).not.toMatch(/\bcall\b/);
    expect(body).not.toMatch(/\bten minutes\b|\bquick chat\b|\bcatch up\b/);
    expect(followup.exampleBody.split("?")).toHaveLength(2);
    expect(followup.exampleBody.trimEnd().endsWith("?")).toBe(true);
  });

  it("drops the copy that earned nothing", () => {
    const body = followup.exampleBody.toLowerCase();
    expect(body).not.toContain("following up on my note");
    expect(body).not.toContain("a lot to juggle");
    expect(body).not.toContain("how we'd approach the search");
    expect(body).not.toContain("realistic timeline");
  });

  it("keeps a rename path from every earlier title", () => {
    expect(followup.legacyNames).toContain("Follow up email 1, short nudge");
  });
});

/**
 * Concrete beats polished. The boutique pitch never names a role and took 383
 * sends to 3 replies; the named open roles exemplar took 5 to 3. Retiring the
 * first leaves the second as the only DNA a new intro is drafted against.
 */
describe("which intro exemplars still draft copy", () => {
  const intros = SEED_TEMPLATES.filter((t) => t.kind === "intro");

  it("retires the boutique pitch without deleting the record", () => {
    const boutique = intros.find((t) => t.name.includes("boutique"))!;
    expect(boutique.isActive).toBe(false);
    // Still on the record as a real send that once won a reply.
    expect(boutique.isProven).toBe(true);
    expect(boutique.exampleBody.length).toBeGreaterThan(0);
  });

  it("leaves the named open roles pattern as the live intro DNA", () => {
    const active = intros.filter((t) => t.isActive !== false);
    expect(active.map((t) => t.name)).toEqual(["Intro email, named open roles"]);
    expect(active[0].exampleBody).toContain("openings in West Palm Beach");
  });

  it("retires nothing else by accident", () => {
    expect(
      SEED_TEMPLATES.filter((t) => t.isActive === false).map((t) => t.name),
    ).toEqual(["Intro email, boutique firm pitch"]);
  });
});

describe("template naming convention", () => {
  it("never puts a parenthetical in a name", () => {
    // Names used to stack "(won reply)" against the rendered "(intro)".
    for (const t of SEED_TEMPLATES) {
      expect(t.name, `parenthetical in name: ${t.name}`).not.toMatch(/[()]/);
    }
  });

  it("keeps provenance out of the name and in the isProven field", () => {
    for (const t of SEED_TEMPLATES) {
      expect(t.name.toLowerCase()).not.toContain("won reply");
    }
    const proven = SEED_TEMPLATES.filter((t) => t.isProven);
    expect(proven.map((t) => t.name)).toEqual([
      "Intro email, boutique firm pitch",
      "Intro email, named open roles",
    ]);
  });

  it("states the medium in every name so channel is never ambiguous", () => {
    for (const t of SEED_TEMPLATES) {
      const medium = t.channel === "email" ? /\bemail\b/i : /\btext\b/i;
      expect(medium.test(t.name), `${t.channel} not stated in: ${t.name}`).toBe(
        true,
      );
    }
  });

  it("names the email and text variants of a reply kind in parallel", () => {
    for (const kind of REPLY_TEMPLATE_KINDS) {
      const email = SEED_TEMPLATES.find(
        (t) => t.kind === kind && t.channel === "email",
      );
      const text = SEED_TEMPLATES.find(
        (t) => t.kind === kind && t.channel === "imessage",
      );
      expect(email?.name.replace(/\bemail\b/i, "@")).toBe(
        text?.name.replace(/\btext\b/i, "@"),
      );
    }
  });

  it("reads cleanly beside the step label the admin table renders", () => {
    for (const t of SEED_TEMPLATES) {
      const row = `${t.name} ${templateKindLabel(t.kind)}`;
      expect(row).not.toMatch(/[()]/);
    }
  });

  it("gives every name a single comma clause saying what it does", () => {
    for (const t of SEED_TEMPLATES) {
      const parts = t.name.split(",");
      expect(parts, `expected one comma in: ${t.name}`).toHaveLength(2);
      expect(parts[1].trim().length).toBeGreaterThan(3);
    }
  });

  it("keeps names unique", () => {
    const names = SEED_TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("renames every previous name so live rows migrate on seed", () => {
    const legacy = SEED_TEMPLATES.flatMap((t) => t.legacyNames ?? []);
    for (const name of [
      "Boutique legal recruitment (won reply)",
      "Role specific technical intro (won reply)",
      "Positive reply, availability",
      "Positive reply text, calendar link",
      "Info request, hand off ack",
      "Info request text, hand off ack",
      "Decline, graceful close",
      "Decline text, graceful close",
      "Text 1, same day intro",
      "Text 2, value nudge",
      "Text 3, final",
      "Follow up 1, short nudge",
      "Follow up 2, final email",
      "Booking confirmation text",
    ]) {
      expect(legacy, `no rename path from: ${name}`).toContain(name);
    }
  });

  it("never lists a legacy name that is also a current name", () => {
    const current = new Set(SEED_TEMPLATES.map((t) => t.name));
    for (const t of SEED_TEMPLATES) {
      for (const legacyName of t.legacyNames ?? []) {
        expect(current.has(legacyName), `${legacyName} is still in use`).toBe(
          false,
        );
      }
    }
  });
});
