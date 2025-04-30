// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PdfModule } from './pdf/pdf.module';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), PdfModule] })
export class AppModule {}
