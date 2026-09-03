# SAUT API

API HTTP/WebSocket de SAUT construida como monolito modular con NestJS 12 y
Fastify. PostgreSQL se accede mediante Prisma ORM; Redis gestiona rate limiting
y MinIO/S3 almacena assets.

## Desarrollo

Requisitos: Node.js 24.20.0 LTS, npm 12.0.2 y la infraestructura de
`docker/docker-compose.yml` del workspace.

```bash
npm ci
npm run dev
```

`npm run dev` aplica migraciones Prisma pendientes, ejecuta el bootstrap
idempotente de seeds e inicia el watcher. El esquema de la base de datos tiene
una única fuente de migraciones: `prisma/migrations`. La importación de bases
heredadas es explícita mediante `MIGRATION_IMPORT_LEGACY_DATABASES=true`; su
eliminación está desactivada por defecto.

## Prisma

```bash
npm run prisma:validate
npm run prisma:generate
npm run prisma:status
npm run prisma:deploy
```

Para una base ya existente, registra el baseline una sola vez:

```bash
npx prisma migrate resolve --applied 20260701000000_baseline
```

La migración SQL baseline conserva checks e índices por expresión que Prisma
Client no representa. `PrismaDataSource` centraliza consultas y lifecycle; las
transacciones heredadas permanecen encapsuladas mientras se migran
gradualmente a `$transaction`. El comando `npm run bootstrap` asume que
`prisma migrate deploy` ya se ejecutó.

## Calidad

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:coverage
npm run build
npm run e2e
```

Las pruebas unitarias no requieren una base real. `npm run e2e` requiere la
infraestructura y la API iniciadas.

## Flujo Git

- `main`: estado estable.
- `develop`: integración.
- `feature/*`, `test/*`, `fix/*`, `refactor/*` y `chore/*`: trabajo aislado.
- Las ramas se fusionan con `--no-ff`; no se usa force push.
