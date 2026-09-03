import { DynamicModule, Module } from "@nestjs/common";
import type { FastifyInstance } from "fastify";

import type { AppContext } from "./types.js";
import {
  AssetsModule,
  AuthModule,
  CatalogModule,
  CommerceModule,
  OperationsModule,
  WebhooksModule,
  SupportAnalyticsModule
} from "./nest/domain-modules.js";
import { PlatformModule } from "./nest/platform.module.js";

@Module({})
export class AppModule {
  static forRoot(context: AppContext, server: FastifyInstance, ownsContext: boolean): DynamicModule {
    return {
      module: AppModule,
      imports: [
        PlatformModule.forRoot(context, server, ownsContext),
        AuthModule,
        CatalogModule,
        CommerceModule,
        OperationsModule,
        WebhooksModule,
        AssetsModule,
        SupportAnalyticsModule
      ]
    };
  }
}
