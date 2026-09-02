# SAUT API: requisitos y comandos

## Runtime fijado

- Node.js LTS 24.20.0 (`.node-version` y `.nvmrc`)
- npm 12.0.2 (`packageManager`)
- NestJS 12.0.1 sobre Fastify 5.12.1
- Prisma/adapter-pg 7.10.0, PostgreSQL 18.6, Redis 8.10.1
- Zod 4.5.4, Stripe 22.6.1, AWS SDK S3 3.1124.0 y Vitest 4.1.11

Prepare las variables con `.env.example`, levante los servicios definidos en el
Compose raíz y use una instalación limpia:

```powershell
npm ci
npm run prisma:validate
npm run lint
npm run typecheck
npm run test:unit
npm run test:coverage
npm run build
```

`npm run dev` aplica únicamente las migraciones versionadas con
`prisma migrate deploy`; no ejecuta reset ni cambios destructivos de base de
datos. Revise `npm run prisma:status` antes de operar sobre una base existente.

## Migraciones de librerías

La configuración de entorno se adaptó a Zod 4: los booleanos se procesan antes
de validar y conservan exactamente los valores admitidos (`1`, `true`, `yes` y
`on`). NestJS 12, Fastify 5, Prisma 7, Redis 6, el SDK de AWS, Stripe y la capa
WebSocket se ejecutan con sus APIs actuales sin cambiar contratos HTTP, cookies,
autorización, S3 ni realtime.

El almacenamiento local y de CI usa el último contenedor oficial de MinIO
Community que sigue publicado (`RELEASE.2025-09-07T16-13-09Z.hotfix.7aa24e772`).
La edición Community pasó a distribución source-only y AIStor requiere una
licencia para aceptar operaciones S3; por eso AIStor no se deja como valor por
defecto sin una licencia disponible.

Prisma 8 estaba publicado sólo como prerelease durante esta actualización; por
eso se usa Prisma 7.10.0, su última versión estable. TypeScript 6.0.3 es el
máximo compatible con `typescript-eslint` 8.x; el proyecto conserva tipos de
Node 24 para coincidir con el runtime LTS fijado.

## Automatización

`.github/workflows/ci.yml` usa Node 24.20.0 y npm 12.0.2, instala con `npm ci`,
audita dependencias y valida lint, tipos, pruebas con cobertura, esquema de
Prisma y build. El job E2E levanta PostgreSQL 18, Redis 8 y MinIO Community
aislados, comprueba `/ready`, el handshake WebSocket `/ws/map` y el recorrido
catálogo → carrito → checkout → pago simulado → pedido.
