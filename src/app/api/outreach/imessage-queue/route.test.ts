import { getTableName } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Mac worker's poll is the last gate before a text actually leaves a
 * phone, so it is the one that has to hold the backlog.
 *
 * Apple disabled the operator's iMessage after three days of business use.
 * Eight texts were already queued when that happened, and they must neither
 * drain nor be thrown away: the worker is handed an empty list with a reason,
 * while the rows stay exactly as they are for a human to decide about.
 */

type Row = Record<string, unknown>;

const selectResults = new Map<string, Row[]>();
const updates: Array<{ table: string; set: Row }> = [];
const inserts: Array<{ table: string; values: Row }> = [];

function thenable(result: Row[]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  Object.assign(chain, {
    from: self,
    where: self,
    orderBy: self,
    limit: self,
    innerJoin: self,
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
        const name = getTableName(table);
        inserts.push({ table: name, values });
        return thenable([{ id: `${name}-inserted` }]);
      },
    }),
    update: (table: Parameters<typeof getTableName>[0]) => ({
      set: (set: Row) => {
        updates.push({ table: getTableName(table), set });
        return thenable([]);
      },
    }),
  },
}));

vi.mock("@/lib/auth", () => ({
  verifyWorkerAuth: () => true,
  unauthorized: () => new Response("no", { status: 401 }),
}));

const settings = {
  enabled: true,
  dryRun: false,
  textEnabled: true,
  requireApproval: false,
  dailySendCap: 100,
};
vi.mock("@/lib/outreach/settings", () => ({
  getOrCreateOutreachSettings: async () => settings,
}));
vi.mock("@/lib/outreach/send-caps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/outreach/send-caps")>()),
  sentTodayOnChannel: async () => 0,
}));
vi.mock("@/lib/outreach/suppression", () => ({
  isSuppressed: async () => ({ suppressed: false, reason: null }),
}));

/** One of the eight texts sitting in the queue, joined to its enrollment. */
function queuedText(id: string) {
  return {
    message: {
      id,
      body: "Hey Stacy, Alejandro again with V Executive Search.",
      attemptCount: 0,
      approvedAt: new Date(),
    },
    enrollment: { id: `enr-${id}`, phoneNumber: "+17864083193" },
  };
}

const poll = async () => {
  const { GET } = await import("@/app/api/outreach/imessage-queue/route");
  const response = await GET(
    new NextRequest("https://crm.test/api/outreach/imessage-queue"),
  );
  return (await response.json()) as {
    messages: Array<{ id: string }>;
    reason?: string;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  settings.enabled = true;
  settings.dryRun = false;
  settings.textEnabled = true;
  selectResults.clear();
  updates.length = 0;
  inserts.length = 0;
  selectResults.set("outreach_messages", [
    queuedText("msg-1"),
    queuedText("msg-2"),
  ] as unknown as Row[]);
});

describe("the Mac worker's queue poll", () => {
  it("hands over due texts while the channel is on", async () => {
    const body = await poll();
    expect(body.messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    expect(body.reason).toBeUndefined();
  });

  it("returns an empty queue with a reason when the text channel is off", async () => {
    settings.textEnabled = false;
    const body = await poll();
    expect(body.messages).toEqual([]);
    expect(body.reason).toBe("text_disabled");
  });

  it("holds the backlog rather than draining or cancelling it", async () => {
    settings.textEnabled = false;
    await poll();
    // No status flip to skipped/cancelled, no events, nothing touched at all.
    expect(updates).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it("keeps naming the kill switch and dry-run ahead of the channel", async () => {
    settings.enabled = false;
    expect((await poll()).reason).toBe("kill_switch");

    settings.enabled = true;
    settings.dryRun = true;
    expect((await poll()).reason).toBe("dry_run");
  });
});
