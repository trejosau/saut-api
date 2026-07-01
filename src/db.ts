export { database, prisma, PrismaDataSource, type Queryable, type QueryResult } from "./database/prisma-data-source.js";

import { database } from "./database/prisma-data-source.js";

export async function pingDatabase(): Promise<void> {
  await database.ping();
}

export async function closeDatabase(): Promise<void> {
  await database.close();
}
