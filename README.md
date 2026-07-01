# SAUT API

API HTTP/WebSocket de SAUT construida como monolito modular con NestJS 11 y
Fastify. PostgreSQL se accede mediante Prisma ORM; Redis gestiona rate limiting
y MinIO/S3 almacena assets.

## Desarrollo

Requisitos: Node.js 24 y la infraestructura del `compose.yml` del proyecto raíz.

```bash
npm install
npm run dev
```

`npm run dev` aplica migraciones Prisma pendientes, ejecuta el bootstrap
idempotente de seeds e inicia el watcher. La importación de bases heredadas es
explícita mediante `MIGRATION_IMPORT_LEGACY_DATABASES=true`; su eliminación está
desactivada por defecto.

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
transacciones heredadas permanecen encapsuladas mientras se migran gradualmente
a `$transaction`.

## Calidad

```bash
npm run lint
npm run typecheck
npm run test:unit
npm run test:coverage
npm run build
```

Las pruebas usan Vitest y mocks del Prisma Client; las unitarias no requieren
una base real. `npm run e2e` sí requiere la infraestructura y la API iniciadas.

## Flujo Git

- `main`: estado estable.
- `develop`: integración.
- `feature/*`, `test/*`, `fix/*`, `refactor/*` y `chore/*`: trabajo aislado.
- Las ramas se fusionan con `--no-ff`; no se usa force push.
