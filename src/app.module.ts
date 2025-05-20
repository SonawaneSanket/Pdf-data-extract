// src/app.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PdfModule } from './pdf/pdf.module';
import { WordpressModule } from './wordpress/wordpress.module';

@Module({ 
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), 
    PdfModule,
    WordpressModule
  ] 
})
export class AppModule {}
