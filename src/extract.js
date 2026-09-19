import crypto from "node:crypto";

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function textOnly(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function extractPage(html, sourceId, fallbackTitle) {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|form|noscript)\b[\s\S]*?<\/\1>/gi, " ");

  const titleMatch = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1Match = cleaned.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = textOnly(titleMatch?.[1] || h1Match?.[1] || fallbackTitle);

  const mainMatch = cleaned.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const articleMatch = cleaned.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  const scope = mainMatch?.[1] || articleMatch?.[1] || cleaned;

  const blocks = [];
  const blockPattern = /<(h1|h2|h3|h4|p|li|dt|dd|th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of scope.matchAll(blockPattern)) {
    const text = textOnly(match[2]);
    if (text.length >= 20 && text.length <= 2200) blocks.push(text);
  }

  const deduped = [...new Set(blocks)];
  const content = deduped.join("\n");
  if (content.length < 200) throw new Error("Page contained too little useful extractable text");

  const chunks = [];
  let buffer = "";
  let index = 0;
  for (const block of deduped) {
    if (buffer && `${buffer}\n${block}`.length > 1100) {
      chunks.push({ id: `${sourceId}-c${index++}`, sourceId, text: buffer.trim() });
      buffer = "";
    }
    buffer += `${buffer ? "\n" : ""}${block}`;
  }
  if (buffer.trim()) chunks.push({ id: `${sourceId}-c${index++}`, sourceId, text: buffer.trim() });

  return {
    title,
    chunks,
    contentHash: crypto.createHash("sha256").update(content).digest("hex")
  };
}
