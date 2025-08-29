import { TeamsActivityHandler, TurnContext, BotFrameworkAdapter, ConversationReference } from "botbuilder";
import {
  startStandup,
  recordAnswer,
  freezeStandup,
  missingUsers,
  digest,
  getState,
  addMember,
  registerUser  
} from "./standup";
const userRefs = new Map<string, Partial<ConversationReference>>(); // ✅
let generalRef: Partial<ConversationReference> | null = null;

// ---- Emulator identity overrides (one fake user per conversation/tab) ----
type UserOverride = { id: string; name: string };
const userOverrides = new Map<string, UserOverride>(); // key = conversationId

function resolveIdentity(context: TurnContext): { userId: string; name: string } {
  const convId = context.activity.conversation?.id || "conv";
  const o = userOverrides.get(convId);
  if (o) return { userId: o.id, name: o.name };

  const name = (context.activity.from?.name || "").trim() || "Membre";
  const id = (context.activity.from?.id || "").trim() || `emu-${Math.random().toString(36).slice(2, 8)}`;
  return { userId: id, name };
}

// Ordered questions for the guided stand-up
const QUESTIONS = [
  "Quels progrès as-tu réalisés depuis le dernier stand-up ?",
  "Quels sont tes objectifs avant le prochain stand-up ?",
  "As-tu des blocages actuellement ?",
  "As-tu besoin d’une réunion de clarification ou d’aide de l’équipe ?"
];


// Per-user conversation progress (in-memory)
type Conversation = {
  index: number; // 0..3
  answers: { yesterday?: string; today?: string; blockers?: string; other?: string };
};
const conversations = new Map<string, Conversation>();

function displayNameOf(context: TurnContext): string {
  return (context.activity.from?.name || "").trim() || "Membre";
}

export class StandupBot extends TeamsActivityHandler {
  constructor() {
    super();

    this.onMessage(async (context, next) => {
      const text = (context.activity.text || "").trim();
      // If frozen, block everything except a few read-only commands
      if (getState().status === "frozen" && !/^\/(status|digest|digestpost|help)$/i.test(text)) {
        await context.sendActivity("⚠️ La collecte du stand‑up est gelée. Tes réponses ne sont plus acceptées aujourd’hui.");
        return;
      }
      const { userId, name } = resolveIdentity(context);
      userRefs.set(userId, TurnContext.getConversationReference(context.activity));

      // Commands
      if (/^\/status\b/i.test(text)) {
        const s = getState();
        await context.sendActivity(`Status: ${s.status} | Date: ${s.date || "—"} | Réponses: ${s.responses.size}`);
        return;
      }

      if (/^\/freeze\b/i.test(text)) {
        freezeStandup();

        const { missingUsersDetailed } = await import("./standup");
        const miss = missingUsersDetailed();

        if (miss.length) {
          const list = miss.map(m => `**${m.name}**`).join(", ");
          await context.sendActivity(`🧊 Collecte gelée.\n> ⚠️ Pas de réponse d’un ou plusieurs membres : ${list}`);

          // 🔔 Proactively notify each missing member in their last chat
          await Promise.all(miss.map(async (m) => {
            const ref = userRefs.get(m.id);
            if (!ref) return;
              await (context.adapter as BotFrameworkAdapter).continueConversation(ref as Partial<ConversationReference>, async (proactiveCtx) => {
              await proactiveCtx.sendActivity(
                `⏰ Bonjour ${m.name}, la collecte du stand‑up d’aujourd’hui est **gelée**. `
                + `Tu n’as pas terminé tes réponses. Merci de compléter au prochain stand‑up.`
              );
            });
          }));
        } else {
          await context.sendActivity("🧊 Collecte gelée. Tous les membres ont répondu.");
        }
        return;
      }

      if (/^\/digest(\s+full)?\b/i.test(text)) {
        const d = digest(); // current raw digest with names + answers
        const { summarizeStandupFr } = await import("./summarizer");
        const summary = await summarizeStandupFr(d.text);  // clusters via embeddings, 1‑line FR
        await context.sendActivity(summary);
        return;
      }

      // Start a guided stand-up for THIS user
      if (/^\/(start|standup)\b/i.test(text)) {
        const s = getState();
        if (s.status === "frozen") {
          await context.sendActivity("⚠️ La collecte du stand‑up est gelée. Tu ne peux plus commencer ni modifier tes réponses aujourd’hui.");
          return;
        }
        if (s.status === "idle") startStandup([userId]);
        registerUser(userId, name); // register once
        // Create a per-user conversation flow
        conversations.set(userId, { index: 0, answers: {} });

        await context.sendActivity(
          `Bonjour ${name} 👋, commençons ton Stand-up.\nJe vais te poser quelques questions rapides.`
        );
        await context.sendActivity(QUESTIONS[0]);
        return;
      }

              // Save the current chat as the "general" channel
        if (/^\/setgeneral\b/i.test(text)) {
          generalRef = TurnContext.getConversationReference(context.activity);
          await context.sendActivity("✅ Canal général enregistré (cette conversation).");
          return;
        }

        // Clear it if needed
        if (/^\/cleargeneral\b/i.test(text)) {
          generalRef = null;
          await context.sendActivity("🗑️ Canal général effacé.");
          return;
        }

        // Generate digest and POST it to the saved general channel (proactive)
        if (/^\/digestpost\b/i.test(text)) {
          const d = digest();
          const { summarizeStandupFr } = await import("./summarizer");
          const summary = await summarizeStandupFr(d.text);

          if (!generalRef) {
            await context.sendActivity("⚠️ Aucun canal général enregistré. Ouvrez une nouvelle conversation et envoyez `/setgeneral` dans ce canal.");
            return;
          }

          await (context.adapter as BotFrameworkAdapter).continueConversation(
            generalRef as Partial<ConversationReference>,
            async (proactiveCtx) => {
              await proactiveCtx.sendActivity(summary);
            }
          );


          await context.sendActivity("📣 Digest envoyé au canal général.");
          return;
        }

      // If user is mid-standup, capture answer and continue
      const conv = conversations.get(userId);
      if (conv) {
          // stop collecting if frozen
        const sNow = getState();
        if (sNow.status !== "collecting") {
          conversations.delete(userId);
          await context.sendActivity("⚠️ La collecte du stand‑up est gelée. Tes réponses ne sont plus acceptées aujourd’hui.");
          return;
        }
        const idx = conv.index;
        // Store & confirm
        if (idx === 0) {
          conv.answers.yesterday = text;
          await context.sendActivity("Merci, j’ai bien noté.");
        } else if (idx === 1) {
          conv.answers.today = text;
          await context.sendActivity("Merci, j’ai bien noté.");
        } else if (idx === 2) {
          conv.answers.blockers = text;
          await context.sendActivity("Merci, j’ai bien noté.");
        } else if (idx === 3) {
          conv.answers.other = text;

          // Save final answers to global stand-up state WITH the display name
          recordAnswer(userId, 1, conv.answers.yesterday ?? "", name);
          recordAnswer(userId, 2, conv.answers.today ?? "", name);
          recordAnswer(userId, 3, conv.answers.blockers ?? "", name);
          recordAnswer(userId, 4, conv.answers.other ?? "", name);
          registerUser(userId, name);

          conversations.delete(userId);
          await context.sendActivity(`C’est noté, ${name} ✅ Ton point quotidien est terminé.\nBonne journée !`);
          return;
        }

        // Ask next question (if any)
        conv.index++;
        conversations.set(userId, conv);
        if (getState().status === "collecting" && conv.index < QUESTIONS.length) {
          await context.sendActivity(QUESTIONS[conv.index]);
        }
        return;
      }

      // Fallback help
      if (/^help\b/i.test(text)) {
        await context.sendActivity(
          "Commandes:\n" +
          "• /start ou /standup – lancer le stand-up guidé (questions une par une)\n" +
          "• /status – afficher l’état\n" +
          "• /freeze – geler la collecte\n" +
          "• /digest – afficher le résumé"
        );
        return;
      }

      // /as <Name> [<Id>] → set a fake identity for THIS conversation/tab
      if (/^\/as\b/i.test(text)) {
        const parts = text.split(/\s+/).slice(1);
        const fakeName = (parts[0] || "").trim();
        const fakeId = (parts[1] || `emu-${Math.random().toString(36).slice(2, 8)}`).trim();
        if (!fakeName) {
          await context.sendActivity("Usage: /as <Nom> [<Id>]");
          return;
        }
        const convId = context.activity.conversation?.id || "conv";
        userOverrides.set(convId, { id: fakeId, name: fakeName });
        await context.sendActivity(`✅ Identité de cette conversation: **${fakeName}** (${fakeId}).`);
        return;
      }

      // /whoami → show current resolved identity
      if (/^\/whoami\b/i.test(text)) {
        const me = resolveIdentity(context);
        await context.sendActivity(`Tu es **${me.name}** (id: \`${me.userId}\`) dans cette conversation.`);
        return;
      }

      // /clearas → remove override for THIS conversation/tab
      if (/^\/clearas\b/i.test(text)) {
        const convId = context.activity.conversation?.id || "conv";
        userOverrides.delete(convId);
        await context.sendActivity("🗑️ Identité override supprimée pour cette conversation.");
        return;
      }

      await next();
    });
  }
}
