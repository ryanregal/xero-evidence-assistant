import fs from "node:fs/promises";
import path from "node:path";
import { extractPage } from "./extract.js";
import { loadStore, logEvent, saveStore } from "./storage.js";

export async function loadSourceConfig() {
  const configPath = path.resolve(process.env.SOURCE_CONFIG_PATH ?? "config/sources.json");
  const configs = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (!Array.isArray(configs) || configs.length === 0) throw new Error("Source configuration is empty or invalid");

  const ids = new Set();
  for (const source of configs) {
    if (!source?.id || !source?.url || !source?.label) throw new Error("Each source needs id, url and label");
    if (ids.has(source.id)) throw new Error(`Duplicate source id: ${source.id}`);
    ids.add(source.id);
    const parsed = new URL(source.url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Unsupported source URL: ${source.url}`);
  }
  return configs;
}

export const liveFetcher = async (url) => {
  const response = await fetch(url, {
    headers: {
      "user-agent": "XeroEvidenceExercise/1.0 (recruitment exercise; low-volume fetch)",
      "accept": "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    throw new Error(`Unexpected content type: ${contentType}`);
  }
  return response.text();
};

export async function gatherResearch({ refresh = false, fetcher = liveFetcher } = {}) {
  const configs = await loadSourceConfig();
  const store = await loadStore();
  const results = [];
  const configuredIds = new Set(configs.map((source) => source.id));

  let pruned = false;
  for (const existingId of Object.keys(store.sources)) {
    if (!configuredIds.has(existingId)) {
      delete store.sources[existingId];
      pruned = true;
      await logEvent("source_removed", { sourceId: existingId, reason: "not_in_configuration" });
    }
  }
  if (pruned) await saveStore(store);

  for (const config of configs) {
    const previous = store.sources[config.id];
    const sameSuccessfulSource = previous?.url === config.url && previous?.chunks?.length > 0;

    if (!refresh && sameSuccessfulSource) {
      const event = {
        sourceId: config.id,
        action: "reused",
        retrievedAt: previous.retrievedAt,
        lastAttemptStatus: previous.lastAttemptStatus
      };
      results.push(event);
      await logEvent("source_reused", event);
      continue;
    }

    const attemptAt = new Date().toISOString();
    try {
      await logEvent("source_fetch_started", { sourceId: config.id, url: config.url, refresh });
      const html = await fetcher(config.url);
      const extracted = extractPage(html, config.id, config.label);
      const action = previous ? "reprocessed" : "fetched";
      store.sources[config.id] = {
        id: config.id,
        configuredLabel: config.label,
        title: extracted.title,
        url: config.url,
        retrievedAt: attemptAt,
        contentHash: extracted.contentHash,
        chunks: extracted.chunks,
        lastAttemptAt: attemptAt,
        lastAttemptUrl: config.url,
        lastAttemptStatus: "success"
      };
      await saveStore(store);
      const event = {
        sourceId: config.id,
        action,
        retrievedAt: attemptAt,
        chunks: extracted.chunks.length,
        contentChanged: previous ? previous.contentHash !== extracted.contentHash : null
      };
      results.push(event);
      await logEvent(`source_${action}`, event);
    } catch (error) {
      if (previous) {
        previous.lastAttemptAt = attemptAt;
        previous.lastAttemptUrl = config.url;
        previous.lastAttemptStatus = "failed";
        previous.lastError = String(error?.message ?? error);
        store.sources[config.id] = previous;
        await saveStore(store);
      }
      const event = {
        sourceId: config.id,
        action: "failed",
        attemptedAt: attemptAt,
        attemptedUrl: config.url,
        preservedPreviousRetrievedAt: previous?.retrievedAt ?? null,
        error: String(error?.message ?? error)
      };
      results.push(event);
      await logEvent("source_fetch_failed", event);
    }
  }
  return results;
}
