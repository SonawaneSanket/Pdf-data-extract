// src/pdf/pdf.controller.ts
import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { join } from 'path';
import { PdfService, PageSummary } from './pdf.service';
import { Express } from 'express';
import * as fs from 'fs';

function uploadInterceptor() {
  return FileInterceptor('file', {
    storage: diskStorage({
      destination: './uploads',
      filename: (req, file, cb) => {
        const ts = Date.now();
        const clean = file.originalname.replace(/\s+/g, '_');
        cb(null, `${ts}_${clean}`);
      },
    }),
    fileFilter: (req, file, cb) => {
      const isPdf = file.mimetype === 'application/pdf';
      if (req.originalUrl.endsWith('/summarize') && !isPdf) {
        return cb(new Error('Please upload a PDF file'), false);
      }
      cb(null, true);
    },
  });
}

@Controller('pdf')
export class PdfController {
  constructor(private readonly pdfService: PdfService) {}

  // src/pdf/pdf.controller.ts
  @Post('summarize')
  @UseInterceptors(uploadInterceptor())
  async summarize(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<PageSummary[]> {
    const pdfPath = join(process.cwd(), file.path);

    // Create unique output directory using file hash
    const outputDir = join(
      process.cwd(),
      'uploads',
      await this.pdfService.getFileHash(pdfPath), // Use PDF hash as directory name
    );

    // Ensure directory exists
    await fs.promises.mkdir(outputDir, { recursive: true });

    return this.pdfService.convertAndSummarize(pdfPath, outputDir);
  }
}
