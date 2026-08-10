import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { sha256HexOfBytes } from "@paperclipai/shared/portability-hash";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  companyTransferRunService,
  type CompanyTransferPartsIndex,
} from "../services/company-transfer-runs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Manifest-shaped fixture: the ledger only cares about an idempotency key and
// part names, so the fixture is built inline rather than through any container
// packer. Distinct content per call: identical content intentionally derives
// the same idempotency key, which would make separate tests resume each
// other's runs.
let manifestSeq = 0;
function demoManifest(): CompanyTransferPartsIndex & { idempotencyKey: string } {
  manifestSeq += 1;
  return {
    idempotencyKey: sha256HexOfBytes(Buffer.from(`transfer-run-fixture-${manifestSeq}`)),
    chunks: [{ name: "chunks/0000.json.gz" }, { name: "chunks/0001.json.gz" }],
    blobs: [{ name: `blobs/${sha256HexOfBytes(pngBytes)}` }],
  };
}

describeEmbeddedPostgres("companyTransferRunService", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-transfer-runs-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates a run, records parts idempotently, and resumes from the remainder", async () => {
    const manifest = demoManifest();
    const created = await companyTransferRunService.resumeOrCreate(db, {
      direction: "import",
      actorKey: "user:alice",
      idempotencyKey: manifest.idempotencyKey,
      containerRef: { kind: "zip-upload" },
    });
    expect(created.resumed).toBe(false);
    expect(created.run.status).toBe("pending");

    await companyTransferRunService.recordManifest(
      db,
      created.run.id,
      manifest,
      sha256HexOfBytes(Buffer.from(JSON.stringify(manifest))),
    );
    await companyTransferRunService.start(db, created.run.id);

    const firstChunk = manifest.chunks[0]!.name;
    await companyTransferRunService.completePart(db, created.run.id, firstChunk);
    // Re-completing the same part must not double-count.
    await companyTransferRunService.completePart(db, created.run.id, firstChunk);

    const midway = (await companyTransferRunService.getRun(db, created.run.id))!;
    expect(midway.status).toBe("running");
    expect(midway.completedParts).toEqual([firstChunk]);
    expect(midway.chunkCount).toBe(manifest.chunks.length);
    expect(midway.blobCount).toBe(manifest.blobs.length);

    const remaining = companyTransferRunService.remainingParts(midway, manifest);
    expect(remaining).toEqual([
      manifest.chunks[1]!.name,
      ...manifest.blobs.map((blob) => blob.name),
    ]);

    // Simulate an interruption: the run fails, then the same content retries.
    await companyTransferRunService.fail(db, created.run.id, "connection dropped");
    const resumed = await companyTransferRunService.resumeOrCreate(db, {
      direction: "import",
      actorKey: "user:alice",
      idempotencyKey: manifest.idempotencyKey,
      containerRef: { kind: "zip-upload" },
    });
    expect(resumed.resumed).toBe(true);
    expect(resumed.alreadyCompleted).toBe(false);
    expect(resumed.run.id).toBe(created.run.id);
    expect(resumed.run.completedParts).toEqual([firstChunk]);

    await companyTransferRunService.start(db, resumed.run.id);
    for (const part of companyTransferRunService.remainingParts(resumed.run, manifest)) {
      await companyTransferRunService.completePart(db, resumed.run.id, part);
    }
    await companyTransferRunService.complete(db, resumed.run.id);

    const done = (await companyTransferRunService.getRun(db, created.run.id))!;
    expect(done.status).toBe("completed");
    expect(done.error).toBeNull();
    expect(companyTransferRunService.remainingParts(done, manifest)).toEqual([]);

    // A retry of identical content after completion short-circuits.
    const retried = await companyTransferRunService.resumeOrCreate(db, {
      direction: "import",
      actorKey: "user:alice",
      idempotencyKey: manifest.idempotencyKey,
      containerRef: { kind: "zip-upload" },
    });
    expect(retried.alreadyCompleted).toBe(true);
    expect(retried.run.id).toBe(created.run.id);
  });

  it("scopes resume to the actor and direction", async () => {
    const manifest = demoManifest();
    const aliceRun = await companyTransferRunService.resumeOrCreate(db, {
      direction: "export",
      actorKey: "user:alice",
      idempotencyKey: manifest.idempotencyKey,
      containerRef: { kind: "relay", prefix: "staging/a" },
    });

    const bobRun = await companyTransferRunService.resumeOrCreate(db, {
      direction: "export",
      actorKey: "user:bob",
      idempotencyKey: manifest.idempotencyKey,
      containerRef: { kind: "relay", prefix: "staging/b" },
    });
    expect(bobRun.resumed).toBe(false);
    expect(bobRun.run.id).not.toBe(aliceRun.run.id);

    const aliceImport = await companyTransferRunService.resumeOrCreate(db, {
      direction: "import",
      actorKey: "user:alice",
      idempotencyKey: manifest.idempotencyKey,
      containerRef: { kind: "relay", prefix: "staging/a" },
    });
    expect(aliceImport.resumed).toBe(false);
    expect(aliceImport.run.id).not.toBe(aliceRun.run.id);

    expect(await companyTransferRunService.getRunForActor(db, aliceRun.run.id, "user:bob")).toBeNull();
    expect(await companyTransferRunService.getRunForActor(db, aliceRun.run.id, "user:alice")).not.toBeNull();
  });

  it("does not restart a cancelled run", async () => {
    const manifest = demoManifest();
    const { run } = await companyTransferRunService.resumeOrCreate(db, {
      direction: "import",
      actorKey: "user:carol",
      idempotencyKey: manifest.idempotencyKey,
      containerRef: { kind: "zip-upload" },
    });
    await companyTransferRunService.cancel(db, run.id);
    await companyTransferRunService.start(db, run.id);
    expect((await companyTransferRunService.getRun(db, run.id))!.status).toBe("cancelled");

    // Cancelled runs are not resumed; the same content starts a fresh run.
    const fresh = await companyTransferRunService.resumeOrCreate(db, {
      direction: "import",
      actorKey: "user:carol",
      idempotencyKey: manifest.idempotencyKey,
      containerRef: { kind: "zip-upload" },
    });
    expect(fresh.resumed).toBe(false);
    expect(fresh.run.id).not.toBe(run.id);
  });
});
