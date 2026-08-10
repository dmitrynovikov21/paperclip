import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readZipArchive } from "@paperclipai/shared/portability-zip";
import {
  CHUNKED_IMPORT_THRESHOLD_BYTES,
  IMPORT_TRANSFER_PART_SIZE_BYTES,
  buildImportTransferManifest,
  registerCompanyCommands,
  resolveChunkedImportZip,
  uploadCompanyImportTransfer,
} from "../commands/client/company.js";
import { createStoredZipArchive } from "./helpers/zip.js";

const ORIGINAL_ENV = { ...process.env };

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paperclip-company-import-transfer-"));
  tempDirs.push(dir);
  return dir;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Two-part fixture: one full 32 MB part plus a short tail. */
function buildTwoPartZipBytes(): Uint8Array {
  const bytes = new Uint8Array(IMPORT_TRANSFER_PART_SIZE_BYTES + 3);
  bytes.set([1, 2, 3], IMPORT_TRANSFER_PART_SIZE_BYTES);
  return bytes;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("buildImportTransferManifest", () => {
  it("declares the whole zip and its 32 MB byte-range parts with content hashes", () => {
    const zipBytes = buildTwoPartZipBytes();
    const manifest = buildImportTransferManifest(zipBytes);

    expect(manifest.totalBytes).toBe(zipBytes.length);
    expect(manifest.partSizeBytes).toBe(IMPORT_TRANSFER_PART_SIZE_BYTES);
    expect(manifest.zipSha256).toBe(sha256Hex(zipBytes));
    expect(manifest.parts).toEqual([
      {
        index: 0,
        byteSize: IMPORT_TRANSFER_PART_SIZE_BYTES,
        sha256: sha256Hex(zipBytes.subarray(0, IMPORT_TRANSFER_PART_SIZE_BYTES)),
      },
      {
        index: 1,
        byteSize: 3,
        sha256: sha256Hex(zipBytes.subarray(IMPORT_TRANSFER_PART_SIZE_BYTES)),
      },
    ]);
  });
});

describe("resolveChunkedImportZip", () => {
  it("returns null for a zip at or under the threshold", async () => {
    const dir = await makeTempDir();
    const zipPath = path.join(dir, "small.zip");
    await writeFile(zipPath, Buffer.alloc(1024));

    expect(await resolveChunkedImportZip(zipPath)).toBeNull();
  });

  it("reads an oversized zip file as-is so its declared hashes match the file on disk", async () => {
    const dir = await makeTempDir();
    const zipPath = path.join(dir, "big-package.zip");
    const zipBytes = Buffer.alloc(CHUNKED_IMPORT_THRESHOLD_BYTES + 1024, 7);
    await writeFile(zipPath, zipBytes);

    const resolved = await resolveChunkedImportZip(zipPath);
    expect(resolved).not.toBeNull();
    expect(resolved!.rootPath).toBe("big-package");
    expect(resolved!.zipBytes.length).toBe(zipBytes.length);
    expect(sha256Hex(resolved!.zipBytes)).toBe(sha256Hex(zipBytes));
  });

  it("returns null for a folder whose portable content is under the threshold", async () => {
    const dir = await makeTempDir();
    const packageDir = path.join(dir, "small-package");
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, "COMPANY.md"), "# Company\n");

    expect(await resolveChunkedImportZip(packageDir)).toBeNull();
  });

  it("zips an oversized folder in memory with the same walk filters as the inline path", async () => {
    const dir = await makeTempDir();
    const packageDir = path.join(dir, "big-package");
    await mkdir(path.join(packageDir, "blobs"), { recursive: true });
    await mkdir(path.join(packageDir, ".git"), { recursive: true });
    await writeFile(path.join(packageDir, "COMPANY.md"), "# Company\n");
    await writeFile(path.join(packageDir, "notes.txt"), "not portable\n");
    await writeFile(path.join(packageDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(
      path.join(packageDir, "blobs", "4f2d1c9a"),
      Buffer.alloc(CHUNKED_IMPORT_THRESHOLD_BYTES + 1024, 9),
    );

    const resolved = await resolveChunkedImportZip(packageDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.rootPath).toBe("big-package");

    // The archive unzips back into the same bundle the inline source carries.
    const archive = await readZipArchive(resolved!.zipBytes);
    expect(archive.rootPath).toBe("big-package");
    expect(Object.keys(archive.files).sort()).toEqual(["COMPANY.md", "blobs/4f2d1c9a"]);
    expect(archive.files["COMPANY.md"]).toBe("# Company\n");
  });
});

describe("uploadCompanyImportTransfer", () => {
  const zipBytes = buildTwoPartZipBytes();
  type TransferApi = Parameters<typeof uploadCompanyImportTransfer>[0];

  function fakeApi(overrides: { post?: ReturnType<typeof vi.fn>; putRaw?: ReturnType<typeof vi.fn> } = {}) {
    const post = overrides.post
      ?? vi.fn().mockResolvedValue({
        transferId: "transfer-1",
        status: "running",
        alreadyCompleted: false,
        totalParts: 2,
        missingParts: [0, 1],
      });
    const putRaw = overrides.putRaw ?? vi.fn().mockResolvedValue({ ok: true });
    return { api: { post, putRaw } as unknown as TransferApi, post, putRaw };
  }

  it("uploads only the parts the server reports missing", async () => {
    const { api, post, putRaw } = fakeApi({
      post: vi.fn().mockResolvedValue({
        transferId: "transfer-1",
        status: "running",
        alreadyCompleted: false,
        totalParts: 2,
        missingParts: [1],
      }),
    });
    const progress: number[] = [];

    const transferId = await uploadCompanyImportTransfer(api, zipBytes, {
      onProgress: (update) => progress.push(update.uploadedParts),
    });

    expect(transferId).toBe("transfer-1");
    expect(post).toHaveBeenCalledWith(
      "/api/companies/import/transfers",
      expect.objectContaining({ totalBytes: zipBytes.length }),
    );
    expect(putRaw).toHaveBeenCalledTimes(1);
    expect(putRaw.mock.calls[0]![0]).toBe("/api/companies/import/transfers/transfer-1/parts/1");
    expect(putRaw.mock.calls[0]![1]).toHaveLength(3);
    expect(progress).toEqual([2]);
  });

  it("retries a failed part before succeeding", async () => {
    const putRaw = vi.fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue({ ok: true });
    const { api } = fakeApi({ putRaw });

    await expect(uploadCompanyImportTransfer(api, zipBytes)).resolves.toBe("transfer-1");
    // Part 0 took three attempts; part 1 succeeded first try.
    expect(putRaw).toHaveBeenCalledTimes(4);
  });

  it("surfaces the upload error after exhausting the per-part attempts", async () => {
    const putRaw = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const { api } = fakeApi({ putRaw });

    await expect(uploadCompanyImportTransfer(api, zipBytes)).rejects.toThrow("socket hang up");
    expect(putRaw).toHaveBeenCalledTimes(3);
  });

  it("refuses a transfer whose content was already applied", async () => {
    const { api, putRaw } = fakeApi({
      post: vi.fn().mockResolvedValue({
        transferId: "transfer-1",
        status: "completed",
        alreadyCompleted: true,
        totalParts: 2,
        missingParts: [],
      }),
    });

    await expect(uploadCompanyImportTransfer(api, zipBytes)).rejects.toThrow(/already imported/);
    expect(putRaw).not.toHaveBeenCalled();
  });
});

describe("company import command over the chunked transfer path", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_COMPANY_ID;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function runCommand(args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
    });
    registerCompanyCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function minimalPreview() {
    return {
      include: { company: true, agents: true, projects: true, issues: true },
      targetCompanyId: null,
      targetCompanyName: null,
      collisionStrategy: "rename",
      selectedAgentSlugs: [],
      plan: { companyAction: "create", agentPlans: [], projectPlans: [], issuePlans: [] },
      manifest: { agents: [], projects: [], issues: [], skills: [], company: null },
      files: {},
      envInputs: [],
      warnings: [],
      errors: [],
    };
  }

  it("slices an oversized local zip into a transfer and applies it against the spool", async () => {
    const dir = await makeTempDir();
    const zipPath = path.join(dir, "big-package.zip");
    await writeFile(zipPath, Buffer.alloc(CHUNKED_IMPORT_THRESHOLD_BYTES + 1024, 5));

    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        transferId: "transfer-1",
        status: "running",
        alreadyCompleted: false,
        totalParts: 2,
        missingParts: [0, 1],
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, index: 0, alreadyCompleted: false }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, index: 1, alreadyCompleted: false }))
      .mockResolvedValueOnce(jsonResponse(minimalPreview()))
      .mockResolvedValueOnce(jsonResponse({
        company: { id: "company-9", name: "Imported", action: "created" },
        agents: [],
        skills: [],
        projects: [],
        routines: [],
        envInputs: [],
        warnings: [],
      }));

    await runCommand([
      "company",
      "import",
      zipPath,
      "--target",
      "new",
      "--yes",
      "--json",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "board-token",
    ]);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://paperclip.test/api/companies/import/transfers",
      expect.objectContaining({ method: "POST" }),
    );
    const declared = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(declared.totalBytes).toBe(CHUNKED_IMPORT_THRESHOLD_BYTES + 1024);
    expect(declared.parts).toHaveLength(2);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://paperclip.test/api/companies/import/transfers/transfer-1/parts/0",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ "content-type": "application/octet-stream" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://paperclip.test/api/companies/import/transfers/transfer-1/parts/1",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "http://paperclip.test/api/companies/import/transfers/transfer-1/preview",
      expect.objectContaining({ method: "POST" }),
    );
    // Preview and apply carry the meta fields, never an inline source.
    const previewBody = JSON.parse(String(fetchMock.mock.calls[3]![1].body));
    expect(previewBody.target).toEqual({ mode: "new_company", newCompanyName: null });
    expect(previewBody).not.toHaveProperty("source");
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "http://paperclip.test/api/companies/import/transfers/transfer-1/apply",
      expect.objectContaining({ method: "POST" }),
    );
    const applyBody = JSON.parse(String(fetchMock.mock.calls[4]![1].body));
    expect(applyBody).not.toHaveProperty("source");

    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
      company: { id: "company-9" },
    });
  });

  it("keeps small local zips on the inline single-shot path", async () => {
    const dir = await makeTempDir();
    const zipPath = path.join(dir, "small-package.zip");
    await writeFile(zipPath, createStoredZipArchive({ "COMPANY.md": "# Company\n" }, "small-package"));

    fetchMock.mockResolvedValueOnce(jsonResponse(minimalPreview()));

    await runCommand([
      "company",
      "import",
      zipPath,
      "--target",
      "new",
      "--dry-run",
      "--json",
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "board-token",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://paperclip.test/api/companies/import/preview",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.source.type).toBe("inline");
    expect(body.source.files["COMPANY.md"]).toBe("# Company\n");
  });
});
