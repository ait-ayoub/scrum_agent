// summarizer.ts — per-answer LLM summaries with deterministic fallback (no embeddings)

// ---------- utils ----------
function ensurePeriod(s: string) {
  const t = s.trim();
  return /[.?!…]$/.test(t) ? t : t + ".";
}

function stripPrefix(s: string) {
  let t = s.trim();
  t = t.replace(/^(hier|yesterday)\s*[:,-]\s*/i, "");
  t = t.replace(/^(aujourd’hui|aujourdhui|today)\s*[:,-]\s*/i, "");
  t = t.replace(/^\s*(oui|yes|yup|yeah)\s*[,:\-\s]*/i, "");
  return t.trim();
}

// ---------- strict per-answer LLM summarizer ----------
async function summarizeAnswerLLM(
  section: "Blockers" | "Aujourd’hui" | "Hier" | "Notes",
  name: string,
  answer: string
): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.SUMM_MODEL || "mistralai/mistral-7b-instruct";
  if (!apiKey) return null;

  const sys = [
    "Tu es un assistant de stand-up.",
    "Résume en UNE phrase COURTE et en FRANÇAIS la réponse fournie.",
    "Contraintes STRICTES:",
    "- Toujours à la TROISIÈME personne (pas de « je »).",
    `- Commence implicitement par « ${name} ... » (ne répète pas le nom; il sera ajouté ensuite).`,
    "- Conserve tels quels tous les noms d'AUTRES personnes mentionnées.",
    "- Pas d'emoji, pas de liste, pas de guillemets, pas de nom en sortie.",
    "- Pas d'informations non fournies.",
    "- Style télégraphique, 12 mots max."
  ].join(" ");

  const user = [
    `Section: ${section}`,
    "Réponse brute:",
    stripPrefix(answer)
  ].join("\n");

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_PUBLIC_URL || "http://localhost",
      "X-Title": process.env.APP_TITLE || "Scrum Standup Bot"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: Number(process.env.SUMM_MAX_TOKENS || 80),
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ]
    })
  });

  if (!resp.ok) {
    console.error("Per-answer summarize error:", resp.status, await resp.text().catch(() => ""));
    return null;
  }

  const data: any = await resp.json();
  let line: string = (data?.choices?.[0]?.message?.content || "").trim();

  // sanitize to a single clean sentence (no bullets/quotes, no echoed name)
  line = line.replace(/^[\-\*\u2022]\s*/, "");
  line = line.replace(/^["'“”«»]+|["'“”«»]+$/g, "");
  line = line.replace(new RegExp("^" + name + "\\s*[:\\-–]?\\s*", "i"), "");
  if (!line) return null;

  return `**${name}** ${ensurePeriod(line)}`;
}

// ---------- deterministic fallbacks ----------
function fmtBlockerDet(name: string, raw: string) {
  return `**${name}** — Blocage : ${ensurePeriod(stripPrefix(raw))}`;
}
function fmtTodayDet(name: string, raw: string) {
  return `**${name}** ${ensurePeriod(stripPrefix(raw))}`;
}
function fmtYestDet(name: string, raw: string) {
  return `**${name}** ${ensurePeriod(stripPrefix(raw))}`;
}
function fmtNoteDet(name: string, raw: string) {
  return `**${name}** ${ensurePeriod(stripPrefix(raw))}`;
}

// ---------- section mapper ----------
type Item = { who: string; text: string };

async function mapSection(
  section: "Blockers" | "Aujourd’hui" | "Hier" | "Notes",
  items: Item[],
  fallbackFormatter: (n: string, t: string) => string
): Promise<string[]> {
  if (!items.length) {
    if (section === "Blockers") return ["- Aucun blocage signalé."];
    if (section === "Notes") return ["- Rien à signaler."];
    return ["- Pas de mise à jour."];
  }
  const out: string[] = [];
  for (const it of items) {
    const llm = await summarizeAnswerLLM(section, it.who, it.text).catch(() => null);
    out.push(llm || `- ${fallbackFormatter(it.who, it.text)}`);
  }
  return out;
}

// ---------- main entry ----------
export async function summarizeStandupFr(rawDigest: string): Promise<string> {
  // Parse your current digest format: "- **Name**: text" or "- Name: text"
  const lines = rawDigest.split(/\r?\n/);
  // capture any warning/footer lines (e.g., missing users)
  const footerWarnings = lines.filter(l => /^\s*>\s*⚠️/.test(l.trim()));


  const blk: Item[] = [];
  const tod: Item[] = [];
  const yst: Item[] = [];
  const nts: Item[] = [];

  let cur: "blk" | "tod" | "yst" | "nts" | null = null;
  for (const l of lines) {
    if (/^###\s*⚠️\s*Blockers/i.test(l))                      { cur = "blk"; continue; }
    if (/^###\s*✅\s*(Aujourd’hui|Today)/i.test(l))           { cur = "tod"; continue; }
    if (/^###\s*🕗\s*(Hier|Yesterday)/i.test(l))              { cur = "yst"; continue; }
    if (/^###\s*📝\s*(Notes?)/i.test(l))                      { cur = "nts"; continue; }

    const m = l.match(/^-\s*\*\*(.+?)\*\*:\s*(.+)$/) || l.match(/^-\s*([^:]+):\s*(.+)$/);
    if (m && cur) {
      const who  = m[1].trim();
      const text = m[2].trim();
      const item: Item = { who, text };
      if (cur === "blk") blk.push(item);
      if (cur === "tod") tod.push(item);
      if (cur === "yst") yst.push(item);
      if (cur === "nts") nts.push(item);
    }
  }

  const [blkL, todL, ystL, ntsL] = await Promise.all([
    mapSection("Blockers",    blk, fmtBlockerDet),
    mapSection("Aujourd’hui", tod, fmtTodayDet),
    mapSection("Hier",        yst, fmtYestDet),
    mapSection("Notes",       nts, fmtNoteDet),
  ]);

  const out: string[] = [];
  out.push("## 📋 Stand-up — " + (new Date().toISOString().slice(0,10)));
  out.push("", "### ⚠️ Blockers",   ...blkL.map(s => s.startsWith("-") ? s : `- ${s}`));
  out.push("", "### ✅ Aujourd’hui", ...todL.map(s => s.startsWith("-") ? s : `- ${s}`));
  out.push("", "### 🕗 Hier",        ...ystL.map(s => s.startsWith("-") ? s : `- ${s}`));
  out.push("", "### 📝 Notes",       ...ntsL.map(s => s.startsWith("-") ? s : `- ${s}`));
  // append footer warnings from the raw digest
  if (footerWarnings.length) {
    out.push("", ...footerWarnings);
  }
  return out.join("\n");
}
