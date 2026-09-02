import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { AppModule } from "./app.module.js";
import { buildFastifyServer, closeAppContext, createContext } from "./platform.js";
import { ApiExceptionFilter } from "./nest/platform.module.js";
import type { AppContext } from "./types.js";

export async function createApp(existingContext?: AppContext) {
  const ownsContext = existingContext === undefined;
  const context = existingContext ?? await createContext();
  let app: Awaited<ReturnType<typeof buildFastifyServer>> | undefined;
  let nestApp: NestFastifyApplication | undefined;
  try {
    app = await buildFastifyServer(context);
    // Nest's adapter augments Fastify's raw request type with `originalUrl` at runtime.
    const adapter = new FastifyAdapter(app as unknown as ConstructorParameters<typeof FastifyAdapter>[0]);
    nestApp = await NestFactory.create<NestFastifyApplication>(
      AppModule.forRoot(context, app, ownsContext),
      adapter
    );
    nestApp.useGlobalFilters(new ApiExceptionFilter());
    await nestApp.init();
    return { app, nestApp, context };
  } catch (error) {
    try {
      if (nestApp) await nestApp.close();
      else if (app) await app.close();
    } catch {
      // Preserve the startup error while still attempting context cleanup below.
    }
    if (ownsContext) await closeAppContext(context).catch(() => undefined);
    throw error;
  }
}
