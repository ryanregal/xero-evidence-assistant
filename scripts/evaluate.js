import fs from "node:fs/promises";
import { loadLocalEnv } from "../src/config.js";

await loadLocalEnv();

const [{ gatherResearch }, { answerQuestion }, { OllamaClient }, { loadStore, readEvents }] = await Promise.all([
  import("../src/research.js"),
  import("../src/qa.js"),
  import("../src/model.js"),
  import("../src/storage.js")
]);

const model = new OllamaClient();
const refresh = process.argv.includes("--refresh");
const cases = [
  {
    name: "supported",
    question: "Does Xero support online invoicing, bank reconciliation, and multi-currency accounting?",
    expectedBehaviour: "Return supported feature facts with evidence citations and no unsupported additions."
  },
  {
    name: "multi-source",
    question: "Who is Xero designed for, what accounting features does it provide, and are Australian prices shown in AUD and inclusive of GST?",
    expectedBehaviour: "Combine customer, feature and Australian AUD/GST pricing evidence from at least two sources."
  },
  {
    name: "insufficient-evidence",
    question: "What food is served in Xero's staff cafeteria on Tuesdays?",
    expectedBehaviour: "State that the stored research cannot establish this and do not invent an answer."
  },
  {
    name: "repeated",
    question: "Does Xero support online invoicing, bank reconciliation, and multi-currency accounting?",
    expectedBehaviour: "Reuse the existing research without refetching or reprocessing unchanged sources."
  }
];

function evidenceSummary(items) {
  return (items ?? []).map((item) => ({
    id: item.id,
    sourceId: item.sourceId,
    title: item.title,
    url: item.url,
    retrievedAt: item.retrievedAt,
    score: item.score,
    excerpt: item.text.length > 350 ? `${item.text.slice(0, 347)}...` : item.text
  }));
}

function compactAnswer(answer) {
  return {
    status: answer.status,
    claims: answer.claims,
    unknowns: answer.unknowns,
    modelCalled: answer.modelCalled,
    retrievedEvidence: evidenceSummary(answer.evidence)
  };
}

function assess(name, answer, reuseCheck) {
  if (answer.status === "failed") return `Failed: ${answer.error}`;
  if (name === "insufficient-evidence") {
    return answer.status === "insufficient" && answer.claims.length === 0
      ? "Pass: no unsupported factual answer was returned."
      : "Review: expected an insufficient response with no factual claims.";
  }
  if (name === "multi-source") {
    const sourceIds = new Set(answer.claims.flatMap((claim) => claim.sources.map((source) => source.sourceId)));
    return sourceIds.size >= 2
      ? `Pass: the answer cites ${sourceIds.size} sources.`
      : `Review: the answer cites ${sourceIds.size} source; inspect whether the question was genuinely synthesised across sources.`;
  }
  if (name === "repeated") {
    const reused = reuseCheck?.length > 0 && reuseCheck.every((item) => item.action === "reused");
    return reused
      ? "Pass: the pre-question gather reused all unchanged sources without fetching or reprocessing."
      : "Review: reuse was not observed for every configured source.";
  }
  return answer.claims.length > 0
    ? `Pass: ${answer.claims.length} evidence-backed claim(s) returned.`
    : "Review: no supported claim was returned.";
}

await fs.mkdir("evaluation", { recursive: true });
const initialGather = await gatherResearch({ refresh });
const outputs = [];
let hadFailure = initialGather.some((item) => item.action === "failed");

for (const item of cases) {
  let reuseCheck = null;
  if (item.name === "repeated") reuseCheck = await gatherResearch({ refresh: false });

  try {
    const answer = await answerQuestion(item.question, model);
    const actual = compactAnswer(answer);
    outputs.push({
      ...item,
      relevantEvidence: actual.retrievedEvidence,
      actualOutput: {
        status: actual.status,
        claims: actual.claims,
        unknowns: actual.unknowns,
        modelCalled: actual.modelCalled
      },
      reuseCheck,
      assessment: assess(item.name, answer, reuseCheck)
    });
  } catch (error) {
    hadFailure = true;
    const actual = { status: "failed", error: String(error?.message ?? error), claims: [] };
    outputs.push({
      ...item,
      relevantEvidence: [],
      actualOutput: actual,
      reuseCheck,
      assessment: assess(item.name, actual, reuseCheck)
    });
  }
}

const store = await loadStore();
const record = {
  runDate: new Date().toISOString(),
  model: model.name,
  configuration: {
    provider: "Ollama local runtime",
    temperature: model.temperature,
    modelTimeoutMs: model.timeoutMs,
    maxOutputTokens: model.numPredict,
    contextWindowTokens: model.numCtx,
    retrievalTopK: 4,
    retrieval: "lexical scoring with per-source diversity"
  },
  sourceRetrievalDates: Object.values(store.sources).map((source) => ({
    id: source.id,
    title: source.title,
    url: source.url,
    retrievedAt: source.retrievedAt,
    lastAttemptStatus: source.lastAttemptStatus,
    lastAttemptAt: source.lastAttemptAt
  })),
  initialGather,
  cases: outputs,
  activity: await readEvents(250)
};

await fs.writeFile("evaluation/latest.json", JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));
if (hadFailure) process.exitCode = 1;
