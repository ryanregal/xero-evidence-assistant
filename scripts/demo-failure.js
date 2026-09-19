import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "xero-evidence-failure-"));
process.env.DATA_DIR = tempDir;

const { gatherResearch } = await import("../src/research.js");
const { loadStore } = await import("../src/storage.js");

const fixtureHtml = (url) => `<html><head><title>Xero test source</title></head><body><main><h1>Xero test source</h1><p>Stored accounting evidence from ${url}. This fixture represents a previously successful public-page fetch.</p><p>Xero provides invoicing, reporting, bank reconciliation and other accounting features for businesses. This second paragraph makes the extract long enough to process safely.</p></main></body></html>`;

try {
  await gatherResearch({ fetcher: async (url) => fixtureHtml(url) });
  const before = await loadStore();
  const timestamps = Object.fromEntries(Object.entries(before.sources).map(([id, source]) => [id, source.retrievedAt]));

  const failedRefresh = await gatherResearch({
    refresh: true,
    fetcher: async () => { throw new Error("synthetic HTTP 503 Service Unavailable"); }
  });
  const afterFailure = await loadStore();

  let unexpectedFetches = 0;
  const reuseAfterFailure = await gatherResearch({
    refresh: false,
    fetcher: async () => { unexpectedFetches++; throw new Error("should not refetch unchanged stored evidence"); }
  });

  const snapshotPreserved = Object.entries(afterFailure.sources).every(([id, source]) => source.retrievedAt === timestamps[id]);
  const failuresVisible = Object.values(afterFailure.sources).every((source) => source.lastAttemptStatus === "failed");
  const reusedAfterFailure = reuseAfterFailure.every((item) => item.action === "reused") && unexpectedFetches === 0;

  console.log(JSON.stringify({ failedRefresh, snapshotPreserved, failuresVisible, reuseAfterFailure, reusedAfterFailure }, null, 2));
  if (!snapshotPreserved || !failuresVisible || !reusedAfterFailure) process.exitCode = 1;
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
