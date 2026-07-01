import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import type { FastifyInstance } from "fastify";

import { registerAssets } from "../modules/assets.js";
import { registerAuth } from "../modules/auth.js";
import { registerCatalog } from "../modules/catalog.js";
import { expirePaymentReservations, registerCommerce } from "../modules/commerce.js";
import { registerOperations } from "../modules/operations.js";
import { registerSupportAnalytics } from "../modules/support-analytics.js";
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
    return registerAuth(this.server, this.context);
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
class PaymentReservationExpiryWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentReservationExpiryWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(@Inject(APP_CONTEXT) private readonly context: AppContext) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      expirePaymentReservations(this.context).catch((error: unknown) => this.logger.error(error));
    }, 60_000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

@Module({ providers: [CommerceRouteRegistrar, PaymentReservationExpiryWorker] })
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

@Module({ providers: [AssetsRouteRegistrar] })
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
