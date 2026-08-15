import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

function isPrivateLanOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(hostname)
    );
  } catch {
    return false;
  }
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const configuredOrigins = process.env.CORS_ORIGIN?.split(',').map((o) =>
    o.trim(),
  );

  app.enableCors({
    origin: (origin, callback) => {
      // Same-origin / non-browser tools (no Origin header)
      if (!origin) {
        callback(null, true);
        return;
      }
      if (configuredOrigins?.includes(origin)) {
        callback(null, true);
        return;
      }
      // Dev convenience: allow phones on the same LAN Wi‑Fi
      if (process.env.NODE_ENV !== 'production' && isPrivateLanOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`CORS blocked for origin: ${origin}`), false);
    },
    credentials: true,
  });

  // Bind to all interfaces so phones on the LAN can reach the API
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  console.log(`API listening on http://0.0.0.0:${port}`);
}
bootstrap();
