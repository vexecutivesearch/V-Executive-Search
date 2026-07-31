import { describe, expect, it } from "vitest";
import { REPLY_TEMPLATE_KINDS } from "@/lib/outreach/reply-playbook";
import { sanitizeOutreachBody } from "@/lib/outreach/sanitizer";
import { SEED_TEMPLATES } from "@/lib/outreach/seed-templates";

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
      "https://calendly.com/odv-vexecutivesearch/30min",
    );
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
