// src/pdf/pdf.service.ts
import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { join } from 'path';
import * as fs from 'fs';
import * as Poppler from 'pdf-poppler';
import * as tesseract from 'node-tesseract-ocr';
import fetch from 'node-fetch';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import * as sharp from 'sharp';
import { exec } from 'child_process';
import * as util from 'util';

export interface PageSummary {
  imageUrl: string;
  title: string;
  description: string;
  embeddedImages: string[];
  logos: string[];
  photos: string[];
}

@Injectable()
export class PdfService {
  private readonly mistralUrl = 'https://api.mistral.ai/v1/chat/completions';
  private readonly mistralKey = process.env.MISTRAL_API_KEY;
  private readonly visionClient = new ImageAnnotatorClient();

  private async extractEmbeddedImages(pdfPath: string, outputDir: string): Promise<string[]> {
    const execAsync = util.promisify(exec);
    const outPrefix = join(outputDir, 'embedded');
    try {
      await execAsync(`pdfimages -all "${pdfPath}" "${outPrefix}"`);
    } catch (e: any) {
      console.error('pdfimages warning:', e.stdout || e.message);
    }
    return fs.readdirSync(outputDir)
      .filter(f => f.startsWith('embedded-') && /\.(png|jpe?g)$/i.test(f))
      .sort()
      .map(f => `http://localhost:3000/files/${f}`);
  }

  private async detectTextBasedLogos(imagePath: string, outputDir: string, pageFilename: string): Promise<string[]> {
    const textLogos: string[] = [];
    try {
      const ocrText = await tesseract.recognize(imagePath, {
        lang: 'eng',
        oem: 1,
        psm: 3,
      });
  
      // Look for specific patterns that might indicate logos
      const potentialLogoText = ocrText.split('\n')
        .filter(line => line.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/))
        .filter(line => line.length > 2 && line.length < 25);
  
      if (potentialLogoText.length > 0) {
        const outName = `${pageFilename.replace('.png','')}_textlogo.png`;
        const outputPath = join(outputDir, outName);
        
        // Crop top section where logos typically appear
        await sharp(imagePath)
          .extract({ left: 0, top: 0, width: 1000, height: 200 })
          .toFile(outputPath);
        
        textLogos.push(`http://localhost:3000/files/${outName}`);
      }
    } catch (error) {
      console.error('Text-based logo detection failed:', error);
    }
    return textLogos;
  }

  async rawDetect(imagePath: string): Promise<{ logos: any[]; objects: any[] }> {
    const imgBuffer = fs.readFileSync(imagePath);
    const logoResp = await this.annotate(imgBuffer, 'LOGO_DETECTION');
    const objResp = await this.annotate(imgBuffer, 'OBJECT_LOCALIZATION');
    return { 
      logos: logoResp.logoAnnotations || [], 
      objects: objResp.localizedObjectAnnotations || [] 
    };
  }

  async convertAndSummarize(pdfPath: string, outputDir: string): Promise<PageSummary[]> {
    const embeddedImages = await this.extractEmbeddedImages(pdfPath, outputDir);
    await Poppler.convert(pdfPath, { format: 'png', out_dir: outputDir, out_prefix: 'page' });
    const pages = fs.readdirSync(outputDir).filter(f => f.startsWith('page-') && f.endsWith('.png')).sort();

    const summaries: PageSummary[] = [];
    for (let i = 0; i < pages.length; i++) {
      const file = pages[i];
      const imagePath = join(outputDir, file);

      const text = await tesseract.recognize(imagePath, { lang: 'eng' });
      const aiResponse = await this.callMistral(text);
      const [titleLine, ...descLines] = aiResponse.split('\n');
      const title = titleLine.replace(/^Title:/i, '').trim();
      const description = descLines.join(' ').replace(/^Description:/i, '').trim();

      let { logos, photos } = await this.detectAndCropLogos(imagePath, outputDir, file);
      if (i === 0) {
        const uniqueLogos = new Set([...logos, ...embeddedImages]);
        logos = Array.from(uniqueLogos);
      }

      summaries.push({
        imageUrl: `http://localhost:3000/files/${file}`,
        title,
        description,
        embeddedImages: i === 0 ? embeddedImages : [],
        logos,
        photos,
      });
    }

    return summaries;
  }

  private async annotate(imgBuffer: Buffer, type: 'LOGO_DETECTION' | 'OBJECT_LOCALIZATION') {
    const [batchResponse] = await this.visionClient.batchAnnotateImages({
      requests: [{ image: { content: imgBuffer }, features: [{ type, maxResults: 50 }] }]
    });
    return batchResponse.responses?.[0] || {};
  }

  private async detectAndCropLogos(imagePath: string, outputDir: string, pageFilename: string): Promise<{ logos: string[]; photos: string[] }> {
    const imgBuffer = fs.readFileSync(imagePath);
    const logos: string[] = [];
    const photos: string[] = [];

    try {
      // Enhanced logo detection with better coordinates handling
      const logoResp: any = await this.annotate(imgBuffer, 'LOGO_DETECTION');
      console.log('Logo Detection Response:', JSON.stringify(logoResp, null, 2));
  
      for (const [idx, ann] of (logoResp.logoAnnotations || []).entries()) {
        const verts = ann.boundingPoly?.vertices;
        if (!verts || verts.length < 3) {
          console.log('Skipping logo annotation with insufficient vertices');
          continue;
        }
  
        // Convert all vertices to absolute coordinates
        const xs = verts.map((v: any) => Math.max(0, v.x || 0));
        const ys = verts.map((v: any) => Math.max(0, v.y || 0));
        
        const left = Math.min(...xs);
        const top = Math.min(...ys);
        const width = Math.max(...xs) - left;
        const height = Math.max(...ys) - top;
  
        // Add 5% padding around the logo
        const padding = Math.min(width, height) * 0.05;
        const extractLeft = Math.max(0, left - padding);
        const extractTop = Math.max(0, top - padding);
        const extractWidth = width + (padding * 2);
        const extractHeight = height + (padding * 2);
  
        const outName = `${pageFilename.replace('.png','')}_logo_${idx}.png`;
        const outputPath = join(outputDir, outName);
        
        await sharp(imgBuffer)
          .extract({ 
            left: Math.round(extractLeft),
            top: Math.round(extractTop),
            width: Math.round(extractWidth),
            height: Math.round(extractHeight)
          })
          .toFile(outputPath);
  
        logos.push(`http://localhost:3000/files/${outName}`);
      }
    } catch (error) {
      console.error('Logo detection failed:', error);
    }

    const textLogos = await this.detectTextBasedLogos(imagePath, outputDir, pageFilename);
    logos.push(...textLogos);
    
    // Process logo detections
    const logoResp: any = await this.annotate(imgBuffer, 'LOGO_DETECTION');
    for (const [idx, ann] of (logoResp.logoAnnotations || []).entries()) {
      const verts = ann.boundingPoly?.vertices;
      if (!verts) continue;
      
      const xs = verts.map((v: any) => v.x || 0);
      const ys = verts.map((v: any) => v.y || 0);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      const width = Math.max(...xs) - left;
      const height = Math.max(...ys) - top;

      const outName = `${pageFilename.replace('.png','')}_logo_${idx}.png`;
      const outputPath = join(outputDir, outName);
      
      await sharp(imgBuffer)
        .extract({ left, top, width, height })
        .toFile(outputPath);

      logos.push(`http://localhost:3000/files/${outName}`);
    }

    // Process object detections
    const objResp: any = await this.annotate(imgBuffer, 'OBJECT_LOCALIZATION');
    const meta = await sharp(imgBuffer).metadata();
    const W = meta.width || 0, H = meta.height || 0;
    
    for (const [idx, ann] of (objResp.localizedObjectAnnotations || []).entries()) {
      const verts = ann.boundingPoly?.normalizedVertices;
      if (!verts) continue;

      const xs = verts.map((v: any) => (v.x || 0) * W);
      const ys = verts.map((v: any) => (v.y || 0) * H);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      const width = Math.max(...xs) - left;
      const height = Math.max(...ys) - top;

      const outName = `${pageFilename.replace('.png','')}_obj_${idx}.png`;
      const outputPath = join(outputDir, outName);
      
      await sharp(imgBuffer)
        .extract({ left, top, width, height })
        .toFile(outputPath);

      photos.push(`http://localhost:3000/files/${outName}`);
    }

    return { logos, photos };
  }

  private async callMistral(text: string): Promise<string> {
    if (!this.mistralKey) throw new HttpException('Missing MISTRAL_API_KEY', HttpStatus.INTERNAL_SERVER_ERROR);
    const res = await fetch(this.mistralUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.mistralKey}` },
      body: JSON.stringify({
        model: 'open-mistral-7b',
        messages: [
          { role: 'system', content: 'Extract a title and description formatted as:\nTitle: <title>\nDescription: <desc>' },
          { role: 'user', content: `Text:\n${text}` }
        ]
      })
    });
    if (!res.ok) throw new HttpException(`Mistral API error: ${res.statusText}`, HttpStatus.BAD_GATEWAY);
    const payload = await res.json() as { choices: { message: { content: string } }[] };
    return payload.choices?.[0]?.message.content || '';
  }
}