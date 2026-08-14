import { describe, expect, it } from "vitest";
import { REPLY_TEMPLATE_KINDS } from "@/lib/outreach/reply-playbook";
import { sanitizeOutreachBody } from "@/lib/outreach/sanitizer";
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
