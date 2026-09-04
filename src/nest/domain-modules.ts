import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { FastifyInstance } from "fastify";

import { config } from "../config.js";
import { cleanupOrphanedAssets, registerAssets } from "../modules/assets.js";
import { registerAuth } from "../modules/auth.js";
import { registerAdvancedAuth } from "../modules/advanced-auth.js";
import { registerPasskeys } from "../modules/passkeys.js";
import { registerCatalog } from "../modules/catalog.js";
import { expirePaymentReservations, recoverOversellRefunds, registerCommerce } from "../modules/commerce.js";
import { registerOperations } from "../modules/operations.js";
import { registerSupportAnalytics } from "../modules/support-analytics.js";
import { registerWebhooks } from "../modules/webhooks.js";
import type { AppContext } from "../types.js";
import { APP_CONTEXT, FASTIFY_SERVER } from "./tokens.js";

abstract class RouteRegistrar {
  constructor(
    protected readonly server: FastifyInstance,
    protected readonly context: AppContext
  ) {}

  abstract onModuleInit(): Promise<void>;
}

@Injectable()
class AuthRouteRegistrar extends RouteRegistrar implements OnModuleInit {
  constructor(
    @Inject(FASTIFY_SERVER) server: FastifyInstance,
    @Inject(APP_CONTEXT) context: AppContext
  ) {
    super(server, context);
  }

  onModuleInit(): Promise<void> {
    return registerAuth(this.server, this.context)
      .then(() => registerAdvancedAuth(this.server, this.context))
      .then(() => registerPasskeys(this.server, this.context));
  }
}

@Module({ providers: [AuthRouteRegistrar] })
export class AuthModule {}

@Injectable()
class CatalogRouteRegistrar extends RouteRegistrar implements OnModuleInit {
  constructor(
    @Inject(FASTIFY_SERVER) server: FastifyInstance,
    @Inject(APP_CONTEXT) context: AppContext
  ) {
    super(server, context);
  }

  onModuleInit(): Promise<void> {
    return registerCatalog(this.server, this.context);
  }
}

@Module({ providers: [CatalogRouteRegistrar] })
export class CatalogModule {}

@Injectable()
class CommerceRouteRegistrar extends RouteRegistrar implements OnModuleInit {
  constructor(
    @Inject(FASTIFY_SERVER) server: FastifyInstance,
    @Inject(APP_CONTEXT) context: AppContext
  ) {
    super(server, context);
  }

  onModuleInit(): Promise<void> {
    return registerCommerce(this.server, this.context);
  }
}

@Injectable()
class PaymentSettlementRecoveryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentSettlementRecoveryWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(@Inject(APP_CONTEXT) private readonly context: AppContext) {}

  onApplicationBootstrap(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runRecovery();
    }, 60_000);
    this.timer.unref();
  }

  private runRecovery(): void {
    if (this.running) return;
    this.running = Promise.all([
      expirePaymentReservations(this.context),
      recoverOversellRefunds(this.context),
    ])
      .then(() => undefined)
      .catch((error: unknown) => this.logger.error(error))
      .finally(() => { this.running = undefined; });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }
}

@Module({ providers: [CommerceRouteRegistrar, PaymentSettlementRecoveryWorker] })
export class CommerceModule {}

@Injectable()
class OperationsRouteRegistrar extends RouteRegistrar implements OnModuleInit {
  constructor(
    @Inject(FASTIFY_SERVER) server: FastifyInstance,
    @Inject(APP_CONTEXT) context: AppContext
  ) {
    super(server, context);
  }

  onModuleInit(): Promise<void> {
    return registerOperations(this.server, this.context);
  }
}

@Module({ providers: [OperationsRouteRegistrar] })
export class OperationsModule {}

@Injectable()
class WebhooksRouteRegistrar extends RouteRegistrar implements OnModuleInit {
  constructor(
    @Inject(FASTIFY_SERVER) server: FastifyInstance,
    @Inject(APP_CONTEXT) context: AppContext
  ) {
    super(server, context);
  }

  onModuleInit(): Promise<void> {
    return registerWebhooks(this.server, this.context);
  }
}

@Module({ providers: [WebhooksRouteRegistrar] })
export class WebhooksModule {}

class AssetCleanupWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AssetCleanupWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(@Inject(APP_CONTEXT) private readonly context: AppContext) {}

  private runCleanup(): void {
    if (this.running) return;
    this.running = cleanupOrphanedAssets(this.context)
      .then((result) => {
        if (result.deletedAssets || result.deletedObjects) this.logger.log(result);
      })
      .catch((error: unknown) => this.logger.error(error))
      .finally(() => { this.running = undefined; });
  }

  onApplicationBootstrap(): void {
    if (this.timer) return;
    this.runCleanup();
    this.timer = setInterval(() => this.runCleanup(), config.ASSET_CLEANUP_INTERVAL_SEC * 1000);
    this.timer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }
}

@Injectable()
class AssetsRouteRegistrar extends RouteRegistrar implements OnModuleInit {
  constructor(
    @Inject(FASTIFY_SERVER) server: FastifyInstance,
    @Inject(APP_CONTEXT) context: AppContext
  ) {
    super(server, context);
  }

  onModuleInit(): Promise<void> {
    return registerAssets(this.server, this.context);
  }
}

@Module({ providers: [AssetsRouteRegistrar, AssetCleanupWorker] })
export class AssetsModule {}

@Injectable()
class SupportAnalyticsRouteRegistrar extends RouteRegistrar implements OnModuleInit {
  constructor(
    @Inject(FASTIFY_SERVER) server: FastifyInstance,
    @Inject(APP_CONTEXT) context: AppContext
  ) {
    super(server, context);
  }

  onModuleInit(): Promise<void> {
    return registerSupportAnalytics(this.server, this.context);
  }
}

@Module({ providers: [SupportAnalyticsRouteRegistrar] })
export class SupportAnalyticsModule {}
