import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import { ErrorFilter } from './common/errors/error.filter.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Request IDs correlate a client-visible error with the server log.
      genReqId: () => crypto.randomUUID(),
      trustProxy: true,
      bodyLimit: 10 * 1024 * 1024, // 10 MiB, bounds CSV upload payloads
    }),
  );

  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: [`'self'`],
        frameAncestors: [`'none'`],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  });

  const allowedOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  // Blanket limit; auth endpoints tighten this further (spec §18).
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    allowList: (request) => request.url.startsWith('/api/v1/health'),
  });

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen({ port, host: '0.0.0.0' });

  // Never log the connection string or any secret (spec §18).
  new Logger('Bootstrap').log(`GridFlex API listening on port ${port}`);
}

await bootstrap();
