import { StandupState, StandupAnswer } from "./types";

const state: StandupState = {
  date: "",
  status: "idle",
  members: [],
  responses: new Map<string, StandupAnswer>()
};

// Keep display names for members who haven't answered yet
const names = new Map<string, string>();

export function registerUser(userId: string, displayName: string) {
  if (displayName?.trim()) names.set(userId, displayName.trim());
  if (!state.members.includes(userId)) state.members.push(userId);
}

export function missingUsersDetailed(): { id: string; name: string }[] {
  const ids = state.members.filter((m) => !state.responses.has(m));
  return ids.map((id) => ({
    id,
    name: (names.get(id)?.trim() || id).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ""
    ).trim() || "Membre"
  }));
}

export function startStandup(members: string[]) {
  state.date = new Date().toISOString().slice(0, 10);
  state.status = "collecting";
  state.members = members;
  state.responses.clear();
}

export function recordAnswer(
  userId: string,
  idx: number,
  text: string,
  displayName?: string
) {
  if (state.status !== "collecting") return;
  const ans = state.responses.get(userId) ?? {};
  if (displayName && !ans.displayName) ans.displayName = displayName;

  if (idx === 1) ans.yesterday = text;
  if (idx === 2) ans.today = text;
  if (idx === 3) ans.blockers = text;
  if (idx === 4) ans.other = text;

  ans.submittedAt = new Date().toISOString();
  state.responses.set(userId, ans);
}

export function freezeStandup() {
  state.status = "frozen";
}

export function addMember(userId: string) {
  if (!state.members.includes(userId)) state.members.push(userId);
}

export function missingUsers(): string[] {
  return state.members.filter((m) => !state.responses.has(m));
}

// Helper to remove duplicate bullets
function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const res: string[] = [];
  for (const line of arr) {
    const key = line.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      res.push(line);
    }
  }
  return res;
}

// standup.ts

// ... keep existing imports/state/startStandup/recordAnswer/freeze/missingUsers/dedupe ...

// Helpers to make the sentences read cleanly
function ensurePeriod(s: string) {
  const t = s.trim();
  return /[.?!…]$/.test(t) ? t : t + ".";
}
function lowerFirst(s: string) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
function stripAffirmations(s: string) {
  // remove leading "oui/yes/yeah/yup," etc.
  return s.replace(/^\s*(oui|yes|yeah|yup)[\s,:\-]*/i, "").trim();
}

export function digest(): { text: string } {
  const date = state.date || new Date().toISOString().slice(0, 10);

  const entries = [...state.responses.entries()];
  const yesterdayLines: string[] = [];
  const todayLines: string[] = [];
  const blockerLines: string[] = [];
  const noteLines: string[] = [];

  for (const [userId, a] of entries) {
    const who = (a.displayName?.trim() || userId).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ""
    ).trim() || "Membre";

    if (a.blockers?.trim()) blockerLines.push(`- ${who}: ${a.blockers.trim()}`);
    if (a.today?.trim())     todayLines.push(`- ${who}: ${a.today.trim()}`);
    if (a.yesterday?.trim()) yesterdayLines.push(`- ${who}: ${a.yesterday.trim()}`);
    if (a.other?.trim())     noteLines.push(`- ${who}: ${a.other.trim()}`);
  }

  const out: string[] = [];
  out.push(`## 📋 Stand‑up — ${date}`);

  if (blockerLines.length) {
    out.push("", "### ⚠️ Blockers", ...dedupe(blockerLines));
  }
  if (todayLines.length) {
    out.push("", "### ✅ Today", ...dedupe(todayLines));
  }
  if (yesterdayLines.length) {
    out.push("", "### 🕗 Yesterday", ...dedupe(yesterdayLines));
  }
  if (noteLines.length) {
    out.push("", "### 📝 Notes", ...dedupe(noteLines));
  }
  
  // If some members haven't answered yet, show them
  const miss = missingUsersDetailed();
  if (miss.length) {
    const list = miss.map(m => `**${m.name}**`).join(", ");
    out.push("", `> ⚠️ Pas de réponse d’un ou plusieurs membres : ${list}`);
  }


  if (out.length === 1) out.push("", "_No updates yet._");
  return { text: out.join("\n") };
}


export function getState() {
  return state;
}
