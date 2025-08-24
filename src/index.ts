import restify from "restify";
import { BotFrameworkAdapter, MemoryStorage, ConversationState, UserState } from "botbuilder";
import * as dotenv from "dotenv";
import { StandupBot } from "./bot";

dotenv.config();

const adapter = new BotFrameworkAdapter({
  appId: process.env.BOT_APP_ID || undefined,
  appPassword: process.env.BOT_APP_PASSWORD || undefined,
});

const memoryStorage = new MemoryStorage();
const conversationState = new ConversationState(memoryStorage);
const userState = new UserState(memoryStorage);

adapter.onTurnError = async (context, error) => {
  console.error("❌ Bot error:", error);
  await context.sendActivity("Oops, an error occurred.");
  await conversationState.clear(context);
  await conversationState.saveChanges(context);
};

const bot = new StandupBot();

const server = restify.createServer();
server.use(restify.plugins.bodyParser());

// ✅ Choose ONE style. Here: callback style (no async on handler, includes next)
server.post("/api/messages", (req, res, next) => {
  adapter.processActivity(req, res, async (context) => {
    await bot.run(context);
  });
  return next();
});

const port = Number(process.env.PORT || 3978);
server.listen(port, () => console.log(`✅ Bot listening on :${port}`));
