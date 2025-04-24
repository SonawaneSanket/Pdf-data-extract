import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors({
    origin: 'http://localhost:5173', // Frontend Vite dev server URL
    methods: 'GET, POST, PUT, DELETE', // Methods allowed
    allowedHeaders: 'Content-Type, Authorization', // Allowed headers
  });
 
  app.useStaticAssets(join(__dirname, '..', 'uploads'), { prefix: '/files/' });
  await app.listen(3000);
  console.log('Server running on http://localhost:3000');
}
bootstrap();  