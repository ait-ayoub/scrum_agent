const OR_URL = "https://openrouter.ai/api/v1/embeddings";
const EMB_MODEL = process.env.EMB_MODEL || "openai/text-embedding-3-small";

export type Embedding = { text: string; vector: number[] };

export async function embedBatch(texts: string[]): Promise<Embedding[]> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");

  const resp = await fetch(OR_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "HTTP-Referer": process.env.APP_PUBLIC_URL || "http://localhost",
      "X-Title": process.env.APP_TITLE || "Scrum Standup Bot"
    },
    body: JSON.stringify({ model: EMB_MODEL, input: texts })
  });

  const ct = resp.headers.get("content-type") || "";
  let raw: string | undefined;

  if (!ct.includes("application/json")) {
    raw = await resp.text().catch(() => "");
    throw new Error(
      `Embeddings non-JSON response (status ${resp.status}): ${String(raw).slice(0, 200)}`
    );
  }

  const data: any = await resp.json().catch(async (e: any) => {
    raw = raw || (await resp.text().catch(() => ""));
    throw new Error(`Embeddings JSON parse failed (status ${resp.status}): ${String(raw).slice(0, 200)}`);
  });

  if (!resp.ok) {
    throw new Error(`Embeddings error ${resp.status}: ${JSON.stringify(data)}`);
  }

  if (!data?.data || !Array.isArray(data.data)) {
    throw new Error(`Embeddings malformed payload: ${JSON.stringify(data).slice(0, 200)}`);
  }

  const vecs: number[][] = data.data.map((d: any) => d.embedding);
  return texts.map((t, i) => ({ text: t, vector: vecs[i] }));
}

export function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function clusterTexts(texts: string[], threshold = 0.92): Promise<string[][]> {
  if (!texts.length) return [];
  const items = await embedBatch(texts);
  const clusters: string[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    if (used.has(i)) continue;
    const group = [items[i].text];
    used.add(i);
    for (let j = i + 1; j < items.length; j++) {
      if (used.has(j)) continue;
      const sim = cosine(items[i].vector, items[j].vector);
      if (sim >= threshold) { group.push(items[j].text); used.add(j); }
    }
    clusters.push(group);
  }
  return clusters;
}
