import { loadStore } from "./storage.js";

const STOP = new Set([
  "xero", "the", "a", "an", "and", "or", "is", "are", "was", "were", "be", "to", "of", "for", "in", "on", "with",
  "what", "which", "who", "how", "does", "do", "can", "could", "would", "about", "tell", "me", "its", "their", "it",
  "much", "many", "please", "give", "show", "explain"
]);

const ALIASES = {
  cost: ["price", "pricing", "plan", "plans"],
  costs: ["price", "pricing", "plan", "plans"],
  price: ["pricing", "plan", "plans"],
  prices: ["price", "pricing", "plan", "plans"],
  pricing: ["price", "prices", "plan", "plans"],
  customer: ["customers", "business", "businesses"],
  customers: ["customer", "business", "businesses"],
  business: ["businesses", "customer", "customers"],
  businesses: ["business", "customer", "customers"],
  capability: ["capabilities", "feature", "features"],
  capabilities: ["capability", "feature", "features"],
  feature: ["features", "capability", "capabilities"],
  features: ["feature", "capability", "capabilities"],
  invoice: ["invoicing", "invoices"],
  invoices: ["invoice", "invoicing"],
  invoicing: ["invoice", "invoices"],
  payroll: ["pay"],
  app: ["apps", "integration", "integrations"],
  apps: ["app", "integration", "integrations"],
  australia: ["au"]
};

function baseTokens(text) {
  return (text.toLowerCase().match(/[a-z0-9$]+/g) ?? [])
    .filter((token) => token.length > 1 && !STOP.has(token));
}

export function tokenize(text) {
  return [...new Set(baseTokens(text))];
}

function variants(term) {
  return [...new Set([term, ...(ALIASES[term] ?? [])])];
}

function tokenCounts(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function matchStats(term, counts, metadataTokens) {
  const terms = variants(term);
  let tf = 0;
  let metadataHit = false;
  for (const variant of terms) {
    tf += counts.get(variant) ?? 0;
    if (metadataTokens.has(variant)) metadataHit = true;
  }
  return { tf, metadataHit };
}

export async function retrieveEvidence(question, limit = 5) {
  const store = await loadStore();
  const queryTerms = tokenize(question);
  if (queryTerms.length === 0) return [];

  const sources = Object.values(store.sources).filter((source) => source.chunks?.length > 0);
  const allChunks = sources.flatMap((source) => source.chunks.map((chunk) => ({ source, chunk })));
  if (allChunks.length === 0) return [];

  const prepared = allChunks.map(({ source, chunk }) => {
    const bodyTokens = baseTokens(chunk.text);
    return {
      source,
      chunk,
      counts: tokenCounts(bodyTokens),
      metadataTokens: new Set(baseTokens(`${source.title} ${source.url}`))
    };
  });

  const df = new Map();
  for (const term of queryTerms) {
    df.set(term, prepared.filter(({ counts, metadataTokens }) => {
      const { tf, metadataHit } = matchStats(term, counts, metadataTokens);
      return tf > 0 || metadataHit;
    }).length);
  }

  const minMatchedTerms = queryTerms.length >= 4 ? 2 : 1;
  const scored = prepared.map(({ source, chunk, counts, metadataTokens }) => {
    let score = 0;
    let matchedTerms = 0;

    for (const term of queryTerms) {
      const { tf, metadataHit } = matchStats(term, counts, metadataTokens);
      if (!tf && !metadataHit) continue;
      matchedTerms++;
      const idf = Math.log((prepared.length + 1) / ((df.get(term) ?? 0) + 1)) + 1;
      score += (tf ? (1 + Math.log(tf)) * idf : 0) + (metadataHit ? 0.75 * idf : 0);
    }

    return {
      ...chunk,
      title: source.title,
      url: source.url,
      retrievedAt: source.retrievedAt,
      score,
      matchedTerms
    };
  })
    .filter((item) => item.matchedTerms >= minMatchedTerms && item.score >= 1)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  const perSource = new Map();
  for (const item of scored) {
    if ((perSource.get(item.sourceId) ?? 0) >= 2) continue;
    selected.push(item);
    perSource.set(item.sourceId, (perSource.get(item.sourceId) ?? 0) + 1);
    if (selected.length >= limit) break;
  }
  return selected;
}
