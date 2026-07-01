import { ArgumentsHost, Catch, Controller, DynamicModule, ExceptionFilter, Get, Global, Header, Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { config } from "../config.js";
import { closeDatabase } from "../db.js";
import { HttpError, readiness } from "../platform.js";
import type { AppContext } from "../types.js";
import { APP_CONTEXT, APP_OWNS_CONTEXT, FASTIFY_SERVER } from "./tokens.js";

@Controller()
class HealthController {
  constructor(@Inject(APP_CONTEXT) private readonly context: AppContext) {}

  @Get("health")
  @Header("content-type", "text/plain; charset=utf-8")
  health(): string {
    return "ok";
  }

  @Get("ready")
  ready(): Promise<{ status: string; service: string; version: string }> {
    return readiness(this.context);
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const status = exception instanceof HttpError
      ? exception.statusCode
      : Number((exception as { statusCode?: number } | null)?.statusCode ?? 500);
    const error = exception instanceof Error ? exception : new Error("Error desconocido");

    if (status >= 500) request.log.error(error);
    reply.status(status).send({
      error: status >= 500 ? "internal_error" : "request_error",
      message: error.message,
      ...(exception instanceof HttpError && exception.details ? { details: exception.details } : {})
    });
  }
}

@Injectable()
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(APP_CONTEXT) private readonly context: AppContext,
    @Inject(APP_OWNS_CONTEXT) private readonly ownsContext: boolean
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.ownsContext) return;
    this.context.redis.disconnect();
    await closeDatabase();
  }
}

@Global()
@Module({})
export class PlatformModule {
  static forRoot(context: AppContext, server: FastifyInstance, ownsContext: boolean): DynamicModule {
    return {
      module: PlatformModule,
      controllers: [HealthController],
      providers: [
        { provide: APP_CONTEXT, useValue: context },
        { provide: APP_OWNS_CONTEXT, useValue: ownsContext },
        { provide: FASTIFY_SERVER, useValue: server },
        { provide: "SAUT_CONFIG", useValue: config },
        InfrastructureLifecycle
      ],
      exports: [APP_CONTEXT, FASTIFY_SERVER, "SAUT_CONFIG"]
    };
  }
}
