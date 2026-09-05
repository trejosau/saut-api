import { config } from "./config.js";
import { createApp } from "./server.js";

const { app, nestApp } = await createApp();

let shutdownPromise: Promise<void> | undefined;
async function shutdown(signal: string) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    app.log.info({ signal }, "Shutting down");
    await nestApp.close();
  })();
  return shutdownPromise;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await nestApp.listen(config.PORT, config.HOST);
  app.log.info({ host: config.HOST, port: config.PORT }, "Server listening");
  console.log(`> Server ready on http://${config.HOST}:${config.PORT}`);
} catch (error) {
  await nestApp.close().catch(() => undefined);
  throw error;
}
