// src/pdf/vision.controller.ts
/*
import { Controller, Get, Query } from '@nestjs/common';
import { VisionService } from './vision.service';

@Controller('vision')
export class VisionController {
  constructor(private readonly visionService: VisionService) {}

  // Endpoint to detect labels in an image
  @Get('detect')
  async detectLabels(@Query('imageUrl') imageUrl: string): Promise<string[]> {
    if (!imageUrl) {
      throw new Error('Please provide an image URL');
    }

    return await this.visionService.detectLabels(imageUrl);
  }
}
*/