// src/pdf/vision.service.ts

/*
import { Injectable } from '@nestjs/common';
import { ImageAnnotatorClient } from '@google-cloud/vision';

@Injectable()
export class VisionService {
  private readonly client: ImageAnnotatorClient;

  constructor() {
    this.client = new ImageAnnotatorClient({
      keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    });
  }

  async detectLabels(imageUrl: string): Promise<string[]> {
    try {
      const [result] = await this.client.labelDetection(imageUrl);
      const labels = result.labelAnnotations;

      return (labels ?? [])
        .map((label) => label.description)
        .filter((desc): desc is string => !!desc);
    } catch (error) {
      console.error('Error with Vision API request:', error?.message || error);
      throw new Error('Failed to fetch labels');
    }
  }

  // Detect logos
  async detectLogos(imageUrl: string): Promise<string[]> {
    try {
      const [result] = await this.client.logoDetection(imageUrl);
      const logos = result.logoAnnotations;

      return (logos ?? [])
        .map((logo) => logo.description)
        .filter((desc): desc is string => !!desc);
    } catch (error) {
      console.error('Error with logo detection:', error?.message || error);
      throw new Error('Failed to detect logos');
    }
  }

  // Detect objects
  async detectObjects(imageUrl: string): Promise<string[]> {
    try {
      const [result] = await this.client.objectLocalization(imageUrl);
  
      if (!result || !result.localizedObjectAnnotations) {
        return [];
      }
  
      const objects = result.localizedObjectAnnotations;
  
      return objects
        .map((object) => object.name)
        .filter((name): name is string => !!name);
    } catch (error) {
      console.error('Error with object detection:', error?.message || error);
      throw new Error('Failed to detect objects');
    }
  }
  
  
}
*/