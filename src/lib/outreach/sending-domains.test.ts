import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_SENDING_DOMAINS,
  ESTABLISHED_SENDING_DOMAINS,
  NEW_SENDING_DOMAINS,
  fromAddressForDomain,
  rootDomainOf,
} from "@/lib/outreach/sending-domains-catalog";
import {
  isAuthorizedResendSpf,
  requiredDnsRecords,
  resolveAuthorizedSpf,
} from "@/lib/outreach/profiles";

type Row = Record<string, unknown>;

const selectResults = new Map<string, Row[]>();
const inserts: Array<{ table: string; values: Row }> = [];

function thenable(result: Row[]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    from: self,
    where: self,
    orderBy: self,
    limit: self,
    returning: () => Promise.resolve(result),
    then: (
      onFulfilled?: (value: Row[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  });
  return chain;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (table: Parameters<typeof getTableName>[0]) =>
        thenable(selectResults.get(getTableName(table)) ?? []),
    }),
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (values: Row) => {
        inserts.push({ table: getTableName(table), values });
        return {
          returning: () => Promise.resolve([{ id: "profile-new", ...values }]),
        };
      },
    }),
  },
}));

describe("sending-domain catalog", () => {
  it("lists the three established domains plus the five new Resend ones", () => {
    expect([...ESTABLISHED_SENDING_DOMAINS]).toEqual([
      "vexecsearch.com",
      "vexecutivesearch.co",
      "vtalentsearch.com",
    ]);
    expect([...NEW_SENDING_DOMAINS]).toEqual([
      "vexecutivetalent.com",
      "vexecutiverecruit.us",
      "vexecutives.com",
      "vexecutiverecruit.work",
      "villatororecruiting.us",
    ]);
    expect(CATALOG_SENDING_DOMAINS).toHaveLength(8);
  });

  it("keeps a display-name wrapper from an existing from-address", () => {
    expect(
      fromAddressForDomain(
        "villatororecruiting.us",
        "Alejandro O Delgado <odv@vexecsearch.com>",
      ),
    ).toBe("Alejandro O Delgado <odv@villatororecruiting.us>");
  });

  it("falls back to odv@domain when no template exists", () => {
    expect(fromAddressForDomain("vexecutives.com")).toBe("odv@vexecutives.com");
  });

  it("uses the last two labels as the root", () => {
    expect(rootDomainOf("vexecutiverecruit.work")).toBe("vexecutiverecruit.work");
    expect(rootDomainOf("send.vexecutivesearch.co")).toBe("vexecutivesearch.co");
  });
});

describe("ensureCatalogSendingProfiles", () => {
  beforeEach(() => {
    selectResults.clear();
    inserts.length = 0;
    selectResults.set("sending_profiles", [
      {
        kind: "email_domain",
        domain: "vexecsearch.com",
        fromAddress: "odv@vexecsearch.com",
        replyToAddress: "odv@vexecutivesearch.com",
      },
      {
        kind: "email_domain",
        domain: "vexecutivesearch.co",
        fromAddress: "odv@vexecutivesearch.co",
        replyToAddress: "odv@vexecutivesearch.com",
      },
      {
        kind: "email_domain",
        domain: "vtalentsearch.com",
        fromAddress: "odv@vtalentsearch.com",
        replyToAddress: "odv@vexecutivesearch.com",
      },
    ]);
  });

  it("inserts only the missing catalog domains as warming at 5/day", async () => {
    const { ensureCatalogSendingProfiles } = await import(
      "@/lib/outreach/sending-domains"
    );
    const result = await ensureCatalogSendingProfiles(
      new Date("2026-08-21T12:00:00Z"),
    );

    expect(result.existing).toEqual([...ESTABLISHED_SENDING_DOMAINS]);
    expect(result.created).toEqual([...NEW_SENDING_DOMAINS]);
    expect(inserts).toHaveLength(5);
    expect(inserts.every((row) => row.values.status === "warming")).toBe(true);
    expect(inserts.every((row) => row.values.dailyLimit === 5)).toBe(true);
    expect(inserts.every((row) => row.values.rampStage === 0)).toBe(true);
    expect(inserts.map((row) => row.values.domain)).toEqual([
      ...NEW_SENDING_DOMAINS,
    ]);
    expect(inserts[0].values.fromAddress).toBe("odv@vexecutivetalent.com");
    expect(inserts[0].values.replyToAddress).toBe("odv@vexecutivesearch.com");
  });

  it("is a no-op when every catalog domain already has a row", async () => {
    selectResults.set(
      "sending_profiles",
      CATALOG_SENDING_DOMAINS.map((domain) => ({
        kind: "email_domain",
        domain,
        fromAddress: `odv@${domain}`,
      })),
    );
    const { ensureCatalogSendingProfiles } = await import(
      "@/lib/outreach/sending-domains"
    );
    const result = await ensureCatalogSendingProfiles();
    expect(result.created).toEqual([]);
    expect(result.existing).toEqual([...CATALOG_SENDING_DOMAINS]);
    expect(inserts).toHaveLength(0);
  });
});

describe("Resend SPF on send.", () => {
  it("accepts the Resend TXT on send.domain", () => {
    expect(
      isAuthorizedResendSpf("v=spf1 include:amazonses.com ~all"),
    ).toBe(true);
    expect(
      resolveAuthorizedSpf(
        {
          "vexecutives.com": [],
          "send.vexecutives.com": ["v=spf1 include:amazonses.com ~all"],
        },
        ["vexecutives.com", "send.vexecutives.com"],
      ).ok,
    ).toBe(true);
  });

  it("follows a Domain Connect include hop to amazonses", () => {
    const hop = "dc-fd741b8612._spfm.send.vexecutivetalent.com";
    const result = resolveAuthorizedSpf(
      {
        "vexecutivetalent.com": [],
        "send.vexecutivetalent.com": [
          `v=spf1 include:${hop} ~all`,
        ],
        [hop]: ["v=spf1 include:amazonses.com ~all"],
      },
      ["vexecutivetalent.com", "send.vexecutivetalent.com"],
    );
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(hop);
  });

  it("rejects a send. SPF that never reaches Resend or SES", () => {
    expect(
      resolveAuthorizedSpf(
        {
          "example.com": [],
          "send.example.com": ["v=spf1 include:_spf.google.com ~all"],
        },
        ["example.com", "send.example.com"],
      ).ok,
    ).toBe(false);
  });

  it("tells the admin flow to create Resend's send. records", () => {
    const records = requiredDnsRecords("villatororecruiting.us");
    expect(records.some((r) => r.host === "send.villatororecruiting.us")).toBe(
      true,
    );
    expect(
      records.some((r) => r.host === "resend._domainkey.villatororecruiting.us"),
    ).toBe(true);
  });
});
