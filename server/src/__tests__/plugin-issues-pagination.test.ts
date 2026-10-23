import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, issues, projects } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as any;
}

describeEmbeddedPostgres("plugin host issue pagination", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let services: ReturnType<typeof buildHostServices> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-issues-pagination-");
    const db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const issuePrefix = `PG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values([
      { id: companyId, name: "Paged company", issuePrefix },
      { id: otherCompanyId, name: "Other company", issuePrefix: `X${issuePrefix}` },
    ]);
    await db.insert(projects).values(["First", "Second", "Third"].map((name) => ({
      companyId,
      name,
      status: "planned",
    })));
    await db.insert(issues).values([
      ...[1, 2, 3, 4].map((number) => ({
        companyId,
        title: `Todo ${number}`,
        status: "todo",
        identifier: `${issuePrefix}-${number}`,
        issueNumber: number,
        createdAt: new Date(`2026-01-0${number}T00:00:00Z`),
        updatedAt: new Date(`2026-01-0${number}T00:00:00Z`),
      })),
      { companyId, title: "Excluded status", status: "done", identifier: `${issuePrefix}-5`, issueNumber: 5 },
      { companyId: otherCompanyId, title: "Excluded company", status: "todo" },
    ]);
    services = buildHostServices(db, "plugin-record-id", "pagination-test", createEventBusStub());
  }, 30_000);

  afterAll(async () => {
    services?.dispose();
    await tempDb?.cleanup();
  });

  it("returns the second issue page and an offset-only suffix after one window", async () => {
    const host = services!;
    const input = { companyId, status: "todo" as const };
    const all = await host.issues.list(input);
    expect(all).toHaveLength(4);
    expect(all.every((issue) => issue.companyId === companyId && issue.status === "todo")).toBe(true);

    const firstPage = await host.issues.list({ ...input, limit: 2, offset: 0 });
    const secondPage = await host.issues.list({ ...input, limit: 2, offset: 2 });
    const suffix = await host.issues.list({ ...input, offset: 1 });
    const emptyPage = await host.issues.list({ ...input, limit: 0, offset: 2 });
    const pastEnd = await host.issues.list({ ...input, limit: 2, offset: 4 });

    expect(firstPage.map((issue) => issue.id)).toEqual(all.slice(0, 2).map((issue) => issue.id));
    expect(secondPage.map((issue) => issue.id)).toEqual(all.slice(2, 4).map((issue) => issue.id));
    expect(suffix.map((issue) => issue.id)).toEqual(all.slice(1).map((issue) => issue.id));
    expect(emptyPage).toEqual([]);
    expect(pastEnd).toEqual([]);
    await expect(host.issues.list({ ...input, limit: 0, assigneeAgentId: "invalid-id" })).rejects.toThrow();
  });

  it("keeps the single host-side window for companies and projects", async () => {
    const host = services!;
    const allCompanies = await host.companies.list({});
    const allProjects = await host.projects.list({ companyId });
    expect(allCompanies).toHaveLength(2);
    expect(allProjects).toHaveLength(3);

    const companyPage = await host.companies.list({ limit: 1, offset: 1 });
    const projectPage = await host.projects.list({ companyId, limit: 1, offset: 1 });
    expect(companyPage.map((company) => company.id)).toEqual(allCompanies.slice(1, 2).map((company) => company.id));
    expect(projectPage.map((project) => project.id)).toEqual(allProjects.slice(1, 2).map((project) => project.id));
  });
});
