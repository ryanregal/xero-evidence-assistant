import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gatherResearch } from "../src/research.js";
import { answerQuestion } from "../src/qa.js";
import { retrieveEvidence } from "../src/retrieval.js";
import { buildResponseSchema, validateModelResponse } from "../src/model.js";

let testDataDir;

const fixtureHtml = (title, body) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body} ${body}</p><p>${body} ${body} More useful public business information for retrieval testing.</p></main></body></html>`;

before(async () => {
  testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "xero-evidence-test-"));
  process.env.DATA_DIR = testDataDir;
});

beforeEach(async () => {
  await fs.rm(testDataDir, { recursive: true, force: true });
  await fs.mkdir(testDataDir, { recursive: true });
});

after(async () => {
  await fs.rm(testDataDir, { recursive: true, force: true });
});

test("successful unchanged research is reused without refetching", async () => {
  let calls = 0;
  const fetcher = async (url) => {
    calls++;
    return fixtureHtml("Xero evidence", `Accounting software information from ${url} including invoices, bills, payroll and reports.`);
  };

  await gatherResearch({ fetcher });
  assert.equal(calls, 4);
  const second = await gatherResearch({ fetcher });
  assert.equal(calls, 4, "second gather must not fetch unchanged sources");
  assert.ok(second.every((result) => result.action === "reused"));
});

test("unrelated question is rejected as insufficient before any model call", async () => {
  const fetcher = async (url) => fixtureHtml("Xero accounting", `Invoices, accounting, payroll and business financial reporting from ${url}.`);
  await gatherResearch({ fetcher });

  let modelCalls = 0;
  const model = {
    name: "must-not-run",
    async ask() {
      modelCalls++;
      throw new Error("model should not have been called");
    }
  };

  const result = await answerQuestion("What food is served in the staff cafeteria on Tuesdays?", model);
  assert.equal(result.status, "insufficient");
  assert.equal(result.modelCalled, false);
  assert.equal(modelCalls, 0);
});

test("failed refresh preserves the last good snapshot and ordinary use still reuses it", async () => {
  const good = async (url) => fixtureHtml("Xero accounting", `Accounting and invoicing facts from ${url}.`);
  await gatherResearch({ fetcher: good });
  const beforeStore = JSON.parse(await fs.readFile(path.join(testDataDir, "research.json"), "utf8"));
  const oldRetrievedAt = beforeStore.sources.about.retrievedAt;

  const failed = await gatherResearch({ refresh: true, fetcher: async () => { throw new Error("synthetic HTTP 503"); } });
  const afterStore = JSON.parse(await fs.readFile(path.join(testDataDir, "research.json"), "utf8"));
  assert.equal(afterStore.sources.about.retrievedAt, oldRetrievedAt);
  assert.equal(afterStore.sources.about.lastAttemptStatus, "failed");
  assert.ok(failed.every((result) => result.action === "failed"));

  let calls = 0;
  const reused = await gatherResearch({ fetcher: async () => { calls++; return ""; } });
  assert.equal(calls, 0, "a failed explicit refresh must not force unchanged evidence to refetch during ordinary use");
  assert.ok(reused.every((result) => result.action === "reused"));
});

test("model output cannot cite evidence outside the retrieved set", () => {
  const raw = JSON.stringify({
    status: "answered",
    claims: [{ text: "A factual claim", evidenceIds: ["invented-c99"] }],
    unknowns: []
  });
  assert.throws(() => validateModelResponse(raw, new Set(["features-c0"])), /outside retrieved set/);
});


test("harmless omitted empty arrays from a local model are normalised", () => {
  const answered = validateModelResponse(
    JSON.stringify({
      claims: [{ text: "Xero supports invoicing.", evidenceIds: ["features-c0"] }]
    }),
    new Set(["features-c0"])
  );
  assert.deepEqual(answered.unknowns, []);

  const insufficient = validateModelResponse(
    JSON.stringify({}),
    new Set(["features-c0"])
  );
  assert.deepEqual(insufficient.claims, []);
  assert.equal(insufficient.unknowns.length, 1);
});


test("response schema restricts citations to retrieved evidence ids", () => {
  const schema = buildResponseSchema(["features-c0", "pricing-c0"]);
  assert.deepEqual(
    schema.properties.claims.items.properties.evidenceIds.items.enum,
    ["features-c0", "pricing-c0"]
  );
  assert.deepEqual(schema.required, ["claims", "unknowns"]);
  assert.equal(schema.properties.status, undefined);
});

test("application derives answer status from validated claims and unknowns", () => {
  const answered = validateModelResponse(
    JSON.stringify({
      status: "insufficient",
      claims: [{ text: "Xero supports invoicing.", evidenceIds: ["features-c0"] }],
      unknowns: []
    }),
    new Set(["features-c0"])
  );
  assert.equal(answered.status, "answered");

  const partial = validateModelResponse(
    JSON.stringify({
      claims: [{ text: "Xero supports invoicing.", evidenceIds: ["features-c0"] }],
      unknowns: ["The stored evidence does not establish current employee numbers."]
    }),
    new Set(["features-c0"])
  );
  assert.equal(partial.status, "partial");

  const insufficient = validateModelResponse(
    JSON.stringify({ claims: [], unknowns: ["The stored evidence does not establish an answer."] }),
    new Set(["features-c0"])
  );
  assert.equal(insufficient.status, "insufficient");
});


test("unknown statements emitted as claims are moved to unknowns", () => {
  const result = validateModelResponse(
    JSON.stringify({
      claims: [
        { text: "Xero supports invoicing.", evidenceIds: ["features-c0"] },
        { text: "The number of Xero employees in Melbourne is unknown.", evidenceIds: ["small-business-c5"] }
      ],
      unknowns: ["number of employees Xero has in Melbourne"]
    }),
    new Set(["features-c0", "small-business-c5"])
  );

  assert.equal(result.status, "partial");
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].text, "Xero supports invoicing.");
  assert.ok(result.unknowns.some((item) => /employees in Melbourne is unknown/i.test(item)));
});

test("response schema tells the model to keep unsupported parts out of claims", () => {
  const schema = buildResponseSchema(["features-c0"]);
  assert.match(schema.properties.claims.description, /explicitly supported/i);
  assert.match(schema.properties.unknowns.description, /cannot establish/i);
  assert.equal(schema.properties.claims.maxItems, 3);
});


test("model instructions keep unknowns scoped and quantitative wording exact", async () => {
  const modelSource = await fs.readFile(new URL("../src/model.js", import.meta.url), "utf8");
  assert.match(modelSource, /Unknowns must correspond only to an explicit part of the user's question/i);
  assert.match(modelSource, /Do not introduce pricing, customer, product or other facts unless they directly answer/i);
  assert.match(modelSource, /people, users and employees are not interchangeable/i);
  assert.match(modelSource, /Do not claim completeness and do not treat unlisted features as unknown/i);
});


test("employee-count wording does not make payroll pricing evidence look relevant", async () => {
  const store = {
    version: 1,
    sources: {
      features: {
        id: "features",
        title: "All Xero Features | Xero AU",
        url: "https://www.xero.com/au/accounting-software/all-features/",
        retrievedAt: "2026-09-19T00:00:00.000Z",
        chunks: [
          {
            id: "features-c0",
            sourceId: "features",
            text: "Online invoicing and bank reconciliation are accounting features for Xero customers."
          }
        ]
      },
      pricing: {
        id: "pricing",
        title: "Recommendation | Xero AU",
        url: "https://www.xero.com/au/pricing-plans/recommendation/",
        retrievedAt: "2026-09-19T00:00:00.000Z",
        chunks: [
          {
            id: "pricing-c0",
            sourceId: "pricing",
            text: "Prices are in AUD and include GST. Some plans include Payroll, Expenses, or Projects, and additional charges may apply."
          }
        ]
      }
    }
  };
  await fs.writeFile(path.join(testDataDir, "research.json"), JSON.stringify(store));

  const evidence = await retrieveEvidence(
    "What accounting features does Xero provide, and how many employees does Xero have in Melbourne today?",
    4
  );

  assert.ok(evidence.some((item) => item.id === "features-c0"));
  assert.ok(!evidence.some((item) => item.id === "pricing-c0"), "payroll text must not satisfy an employee-count query");
});
