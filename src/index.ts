import { config } from "./config.js";
import { createApp } from "./server.js";

const { app, nestApp } = await createApp();

async function shutdown(signal: string) {
  app.log.info({ signal }, "Shutting down");
  await nestApp.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await nestApp.listen(config.PORT, config.HOST);
