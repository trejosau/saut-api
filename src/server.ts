import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { AppModule } from "./app.module.js";
import { buildFastifyServer, createContext } from "./platform.js";
import { ApiExceptionFilter } from "./nest/platform.module.js";
import type { AppContext } from "./types.js";

export async function createApp(existingContext?: AppContext) {
  const context = existingContext ?? await createContext();
  const app = await buildFastifyServer(context);
  // Nest's adapter augments Fastify's raw request type with `originalUrl` at runtime.
  const adapter = new FastifyAdapter(app as unknown as ConstructorParameters<typeof FastifyAdapter>[0]);
  const nestApp = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(context, app, existingContext === undefined),
    adapter
  );
  nestApp.useGlobalFilters(new ApiExceptionFilter());
  await nestApp.init();
  return { app, nestApp, context };
}
