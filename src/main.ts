import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';

const PORT = process.env.PORT || 3020;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Enable CORS
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Health check endpoint
  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  await app.listen(PORT);
  console.log(`[startup] Orchestrator running on http://localhost:${PORT}`);
}

bootstrap().catch((error) => {
  console.error('[startup] Failed to start:', error);
  process.exit(1);
});
