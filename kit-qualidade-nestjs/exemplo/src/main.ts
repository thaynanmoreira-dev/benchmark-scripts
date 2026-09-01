import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Server } from 'node:http';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // `INestApplication` sozinho e `INestApplication<any>`: o parametro de tipo
  // do servidor tem default `any`, e esse `any` do framework vaza para o nosso
  // codigo. Nomear o servidor de verdade fecha o buraco — foi o gate de
  // cobertura de tipos que apontou, o lint deixava passar.
  const app = await NestFactory.create<INestApplication<Server>>(AppModule);
  await app.listen(3000);
}

void bootstrap();
