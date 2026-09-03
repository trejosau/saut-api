import type { S3Client } from "@aws-sdk/client-s3";
import type { FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type Stripe from "stripe";
import type { WebSocket } from "ws";

import type { PrismaDataSource } from "./database/prisma-data-source.js";

export type Actor = {
  accountId: string;
  actorType: string;
  sessionId: string;
  roles: string[];
  permissions: string[];
  mfaRequired?: boolean;
  mfaEnabled?: boolean;
  mfaVerifiedAt?: Date | null;
  stepUpVerifiedAt?: Date | null;
  stepUpMethod?: string | null;
};

export type AppContext = {
  database: PrismaDataSource;
  redis: Redis;
  s3: S3Client;
  stripe: Stripe;
  sockets: Set<WebSocket>;
};

export type AuthedRequest = FastifyRequest & { actor?: Actor };

declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
    rawBody?: string;
  }

  interface FastifyInstance {
    /** Shared infrastructure context attached once during server creation. */
    context: AppContext;
  }
}
