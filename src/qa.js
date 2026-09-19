import { retrieveEvidence } from "./retrieval.js";
import { logEvent } from "./storage.js";

export async function answerQuestion(question, model) {
  const clean = question.trim();
  if (!clean) throw new Error("Question is required");
  if (clean.length > 1000) throw new Error("Question is too long");

  const retrievalStartedAt = Date.now();
  const evidence = await retrieveEvidence(clean, 4);
  await logEvent("retrieval_completed", {
    question: clean,
    durationMs: Date.now() - retrievalStartedAt,
    selectedCount: evidence.length,
    sourceCount: new Set(evidence.map((item) => item.sourceId)).size,
    evidence: evidence.map((item) => ({
      id: item.id,
      sourceId: item.sourceId,
      score: Number(item.score.toFixed(3))
    }))
  });
  if (evidence.length === 0) {
    await logEvent("question_insufficient_before_model", { question: clean });
    return {
      status: "insufficient",
      claims: [],
      unknowns: ["The stored research does not contain sufficiently relevant evidence for this question."],
      evidence: [],
      modelCalled: false
    };
  }

  const modelAnswer = await model.ask(clean, evidence);
  const byId = new Map(evidence.map((item) => [item.id, item]));
  return {
    ...modelAnswer,
    claims: modelAnswer.claims.map((claim) => ({
      ...claim,
      sources: claim.evidenceIds.map((id) => {
        const item = byId.get(id);
        return {
          id,
          sourceId: item.sourceId,
          title: item.title,
          url: item.url,
          retrievedAt: item.retrievedAt
        };
      })
    })),
    evidence: evidence.map((item) => ({
      ...item,
      score: Number(item.score.toFixed(3))
    })),
    modelCalled: true
  };
}
