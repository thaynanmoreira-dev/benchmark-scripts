import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Server } from 'node:http';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // `INestApplication` on its own means `INestApplication<any>`: the server type
  // parameter defaults to `any`, and that framework `any` leaks into our code.
  // Naming the real server closes the hole — the type-coverage gate caught this,
  // the linter let it through.
  const app = await NestFactory.create<INestApplication<Server>>(AppModule);
  await app.listen(3000);
}

void bootstrap();
