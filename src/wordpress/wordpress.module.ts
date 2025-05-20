import { Module } from '@nestjs/common';
import { WordpressService } from './wordpress.service';
import { WordpressController } from './wordpress.controller';
import { PdfModule } from '../pdf/pdf.module';

@Module({
  imports: [PdfModule],
  controllers: [WordpressController],
  providers: [WordpressService],
  exports: [WordpressService]
})
export class WordpressModule {}
