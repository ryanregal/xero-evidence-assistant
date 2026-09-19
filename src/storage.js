import fs from "node:fs/promises";
import path from "node:path";

function paths() {
  const dir = path.resolve(process.env.DATA_DIR ?? "data");
  return {
    dir,
    store: path.join(dir, "research.json"),
    events: path.join(dir, "events.jsonl")
  };
}

export async function ensureDataDir() {
  await fs.mkdir(paths().dir, { recursive: true });
}

export async function loadStore() {
  const { store } = paths();
  await ensureDataDir();
  try {
    const parsed = JSON.parse(await fs.readFile(store, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.sources !== "object") {
      throw new Error("Stored research has an invalid shape");
    }
    return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { version: 1, sources: {} };
  }
}

export async function saveStore(store) {
  const { store: storePath } = paths();
  await ensureDataDir();
  const tmp = `${storePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2));
  await fs.rename(tmp, storePath);
}

export async function logEvent(type, details = {}) {
  const { events } = paths();
  await ensureDataDir();
  const line = JSON.stringify({ at: new Date().toISOString(), type, ...details });
  await fs.appendFile(events, `${line}\n`);
}

export async function readEvents(limit = 80) {
  const { events } = paths();
  await ensureDataDir();
  try {
    const raw = await fs.readFile(events, "utf8");
    return raw.trim().split("\n").filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
