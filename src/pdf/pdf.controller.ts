// src/pdf/pdf.controller.ts
// src/pdf/pdf.controller.ts
import {
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { join } from 'path';
import { PdfService, PageSummary } from './pdf.service';
import { Express } from 'express';

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
      const isImage = file.mimetype.startsWith('image/');
      if (req.originalUrl.endsWith('/summarize') && !isPdf) {
        return cb(new HttpException('Please upload a PDF file', HttpStatus.BAD_REQUEST), false);
      }
      if (req.originalUrl.endsWith('/detect') && !isImage) {
        return cb(new HttpException('Please upload an image file', HttpStatus.BAD_REQUEST), false);
      }
      cb(null, true);
    },
  });
}

@Controller('pdf')
export class PdfController {
  constructor(private readonly pdfService: PdfService) {}

  @Post('summarize')
  @UseInterceptors(uploadInterceptor())
  async summarize(@UploadedFile() file: Express.Multer.File): Promise<PageSummary[]> {
    const pdfPath = join(process.cwd(), file?.path || '');
    const outputDir = join(process.cwd(), 'uploads');
    return this.pdfService.convertAndSummarize(pdfPath, outputDir);
  }

  @Post('detect')
  @UseInterceptors(uploadInterceptor())
  async detect(@UploadedFile() file: Express.Multer.File): Promise<{ logos: any[]; objects: any[] }> {
    const imagePath = join(process.cwd(), file?.path || '');
    return this.pdfService.rawDetect(imagePath);
  }
}