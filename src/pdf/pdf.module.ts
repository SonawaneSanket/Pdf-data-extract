// src/pdf/pdf.module.ts
import { Module } from '@nestjs/common';
import { PdfController } from './pdf.controller';
import { PdfService } from './pdf.service';

@Module({
  controllers: [PdfController],
  providers: [
    PdfService
  ],
  exports: [
    PdfService // Export PdfService so it can be used in other modules
  ]
})
export class PdfModule {}
