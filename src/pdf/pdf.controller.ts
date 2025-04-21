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

@Controller('pdf')
export class PdfController {
  constructor(private readonly pdfService: PdfService) {}

  @Post('summarize')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: './uploads',
        filename: (req, file, cb) => {
          const ts = Date.now();
          const clean = file.originalname.replace(/\s+/g, '_');
          cb(null, `${ts}_${clean}`);
        },
      }),
    }),
  )
  async summarize(@UploadedFile() file: Express.Multer.File): Promise<PageSummary[]> {
    if (!file) {
      throw new HttpException('No file uploaded', HttpStatus.BAD_REQUEST);
    }

    const pdfPath = join(process.cwd(), file.path);
    const outputDir = join(process.cwd(), 'uploads');

    return this.pdfService.convertAndSummarize(pdfPath, outputDir);
  }
}