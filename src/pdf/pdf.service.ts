// src/pdf/pdf.service.ts
import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { join } from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class PdfService {
  private readonly mistralUrl = 'https://api.mistral.ai/v1/chat/completions';
  private readonly mistralKey = process.env.MISTRAL_API_KEY;
  private readonly visionClient = new ImageAnnotatorClient();
  private readonly processedImageHashes = new Set<string>(); // Track processed image hashes

  public async getFileHash(filePath: string): Promise<string> {
    const buffer = await fs.promises.readFile(filePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  private async getImageHash(imagePath: string): Promise<string> {
    const buffer = await fs.promises.readFile(imagePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
  private async isValidImage(imagePath: string): Promise<boolean> {
    console.log(`Validating image at path: ${imagePath}`);
    try {
      const { data } = await sharp(imagePath)
        .raw()
        .toBuffer({ resolveWithObject: true });
      console.log(`Raw data extracted from image. Data length: ${data.length}`);

      const avg = data.reduce((sum, val) => sum + val, 0) / data.length;
      console.log(`Calculated average pixel value: ${avg}`);

      if (avg > 10 && avg < 245) {
        console.log(`Image is valid with average pixel value within range.`);
        return true;
      } else {
        console.log(`Image is invalid. Average pixel value out of range.`);
        return false;
      }
    } catch (err) {
      console.error(
        `Error validating image ${imagePath}:`,
        (err as Error).message,
      );
      return false;
    }
  }

  private async extractEmbeddedImages(
    pdfPath: string,
    outputDir: string,
    fileHash: string,
  ): Promise<string[]> {
    const execAsync = util.promisify(exec);
    const outPrefix = join(outputDir, 'embedded');

    console.log(
      `Starting extraction of embedded images from PDF at: ${pdfPath}`,
    );
    console.log(`Output directory: ${outputDir}, File hash: ${fileHash}`);

    try {
      console.log(`Running pdfimages command with output prefix: ${outPrefix}`);
      await execAsync(`pdfimages -all "${pdfPath}" "${outPrefix}"`);
      console.log(`Successfully extracted images from PDF.`);
    } catch (e: any) {
      console.error('pdfimages warning:', e.stdout || e.message);
      return [];
    }

    console.log(`Reading files from output directory: ${outputDir}`);
    const files = fs
      .readdirSync(outputDir)
      .filter((f) => f.startsWith('embedded-') && /\.(png|jpe?g)$/i.test(f))
      .sort();

    console.log(`Found ${files.length} embedded image(s):`, files);

    const filePaths = files.map((f) => `/files/${fileHash}/${f}`);
    console.log(`Returning file paths:`, filePaths);

    return filePaths;
  }

  private async isDuplicateImage(imagePath: string): Promise<boolean> {
    const imageHash = await this.getImageHash(imagePath);
    if (this.processedImageHashes.has(imageHash)) {
      console.log(`Duplicate image detected: ${imagePath}`);
      return true;
    }
    this.processedImageHashes.add(imageHash);
    return false;
  }
  
  async convertAndSummarize(
    pdfPath: string,
    outputDir: string,
  ): Promise<PageSummary[]> {
    const fileHash = await this.getFileHash(pdfPath);
    console.log(`Generated file hash: ${fileHash}`);

    // Clear and recreate directory
    console.log(`Clearing output directory: ${outputDir}`);
    await fs.promises.rm(outputDir, { recursive: true, force: true });
    await fs.promises.mkdir(outputDir, { recursive: true });
    console.log(`Output directory recreated: ${outputDir}`);

    console.log('Extracting embedded images...');
    const embeddedImages = await this.extractEmbeddedImages(
      pdfPath,
      outputDir,
      fileHash,
    );
    console.log(`Extracted ${embeddedImages.length} embedded images.`);

    console.log('Starting PDF conversion to PNG images...');
    await Poppler.convert(pdfPath, {
      format: 'png',
      out_dir: outputDir,
      out_prefix: 'page',
    });
    console.log('PDF conversion completed.');

    console.log('Reading and processing pages...');
    const pages = fs
      .readdirSync(outputDir)
      .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
      .sort();

    console.log(`Found ${pages.length} page(s) to process.`);

    const summaries: PageSummary[] = [];

    for (let i = 0; i < pages.length; i++) {
      const file = pages[i];
      const imagePath = join(outputDir, file);

      console.log(`Processing page ${i + 1} of ${pages.length}: ${file}`);

      if (!(await this.isValidImage(imagePath))) {
        console.log(`Skipping invalid image: ${file}`);
        continue;
      }
      if (await this.isDuplicateImage(imagePath)) {
        console.log(`Skipping duplicate image: ${file}`);
        continue;
      }

      console.log(`Recognizing text from image: ${file}`);
      const text = await tesseract.recognize(imagePath, { lang: 'eng' });
      const trimmedText = text.trim();

      if (!trimmedText) {
        console.log(`No text found on page: ${file}`);
        continue;
      }

      console.log(`Text recognition successful, sending text to AI...`);
      const aiResponse = await this.callMistral(trimmedText);
      const [titleLine, ...descLines] = aiResponse.split('\n');
      const title = titleLine.replace(/^Title:/i, '').trim();
      const description = descLines
        .join(' ')
        .replace(/^Description:/i, '')
        .trim();

      console.log(
        `AI processed page: ${file}. Title: ${title}, Description: ${description}`,
      );

      console.log('Detecting logos and photos...');
      const { logos, photos } = await this.detectAndCropLogos(
        imagePath,
        outputDir,
        file,
        fileHash,
      );
      console.log(
        `Detected ${logos.length} logo(s) and ${photos.length} photo(s) on page: ${file}`,
      );

      summaries.push({
        imageUrl: `/files/${fileHash}/${file}`,
        title,
        description,
        embeddedImages: i === 0 ? embeddedImages : [],
        logos,
        photos,
      });
    }

    console.log('Summarization complete. Returning results...');
    return summaries;
  }

  private async detectAndCropLogos(
    imagePath: string,
    outputDir: string,
    pageFilename: string,
    fileHash: string,
  ): Promise<{ logos: string[]; photos: string[] }> {
    console.log(`Starting logo and photo detection for image: ${imagePath}`);

    const imgBuffer = fs.readFileSync(imagePath);
    const logos: string[] = [];
    const photos: string[] = [];

    try {
      console.log('Starting logo detection...');
      const logoResp: any = await this.annotate(imgBuffer, 'LOGO_DETECTION');
      const { width: imgW = 0, height: imgH = 0 } =
        await sharp(imgBuffer).metadata();
      console.log(`Image dimensions: ${imgW}x${imgH}`);

      for (const [idx, ann] of (logoResp.logoAnnotations || []).entries()) {
        const verts = ann.boundingPoly?.vertices;
        if (!verts || verts.length < 3) continue;

        const xs = verts.map((v: any) => Math.max(0, v.x || 0));
        const ys = verts.map((v: any) => Math.max(0, v.y || 0));

        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const wF = Math.max(...xs) - minX;
        const hF = Math.max(...ys) - minY;
        const pad = Math.min(wF, hF) * 0.05;

        const left = Math.max(0, Math.round(minX - pad));
        const top = Math.max(0, Math.round(minY - pad));
        const width = Math.min(imgW - left, Math.round(wF + pad * 2));
        const height = Math.min(imgH - top, Math.round(hF + pad * 2));

        const outputPath = join(
          outputDir,
          `${pageFilename.replace('.png', '')}_logo_${idx}.png`,
        );
        console.log(
          `Extracting logo ${idx} with dimensions: ${width}x${height} at (${left}, ${top})`,
        );
        await sharp(imgBuffer)
          .extract({ left, top, width, height })
          .toFile(outputPath);

        logos.push(
          `/files/${fileHash}/${pageFilename.replace('.png', '')}_logo_${idx}.png`,
        );
      }
      console.log(`Detected ${logos.length} logos.`);
    } catch (error) {
      console.error('Logo detection failed:', (error as Error).message);
    }

    try {
      console.log('Starting object detection...');
      const objResp: any = await this.annotate(
        imgBuffer,
        'OBJECT_LOCALIZATION',
      );
      const { width: W = 0, height: H = 0 } = await sharp(imgBuffer).metadata();
      console.log(`Image dimensions for object detection: ${W}x${H}`);

      for (const [idx, ann] of (
        objResp.localizedObjectAnnotations || []
      ).entries()) {
        const verts = ann.boundingPoly?.normalizedVertices;
        if (!verts) continue;

        const xs = verts.map((v: any) => (v.x || 0) * W);
        const ys = verts.map((v: any) => (v.y || 0) * H);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const wF = Math.max(...xs) - minX;
        const hF = Math.max(...ys) - minY;

        const left = Math.max(0, Math.round(minX));
        const top = Math.max(0, Math.round(minY));
        const width = Math.min(W - left, Math.round(wF));
        const height = Math.min(H - top, Math.round(hF));

        const outName = `${pageFilename.replace('.png', '')}_obj_${idx}.png`;
        console.log(
          `Extracting object ${idx} with dimensions: ${width}x${height} at (${left}, ${top})`,
        );
        await sharp(imgBuffer)
          .extract({ left, top, width, height })
          .toFile(join(outputDir, outName));

        photos.push(`/files/${fileHash}/${outName}`);
      }
      console.log(`Detected ${photos.length} photos.`);
    } catch (error) {
      console.error('Object detection failed:', (error as Error).message);
    }

    console.log(
      `Detection complete. Found ${logos.length} logos and ${photos.length} photos.`,
    );
    return { logos, photos };
  }

  private async annotate(
    imgBuffer: Buffer,
    type: 'LOGO_DETECTION' | 'OBJECT_LOCALIZATION',
  ) {
    console.log(`Starting annotation for image buffer. Type: ${type}`);

    try {
      console.log('Sending annotation request...');
      const [batchResponse] = await this.visionClient.batchAnnotateImages({
        requests: [
          {
            image: { content: imgBuffer },
            features: [{ type, maxResults: 50 }],
          },
        ],
      });

      console.log('Annotation request completed. Processing response...');
      const response = batchResponse.responses?.[0] || {};

      if (response.error) {
        console.error('Error in annotation response:', response.error.message);
      } else {
        console.log('Annotation response received:', response);
      }

      return response;
    } catch (error) {
      console.error('Annotation failed:', (error as Error).message);
      throw error; // Re-throwing the error for further handling if necessary
    }
  }

  private async callMistral(
    text: string,
    retries = 3,
    backoff = 1000,
  ): Promise<string> {
    console.log('Starting Mistral API call...');
    if (!this.mistralKey) {
      console.error('MISTRAL_API_KEY is missing.');
      throw new HttpException(
        'Missing MISTRAL_API_KEY',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    console.log(`Mistral API key is present. Preparing request...`);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(
          `Attempt ${attempt} of ${retries}. Sending request to Mistral API...`,
        );

        const res = await fetch(this.mistralUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.mistralKey}`,
          },
          body: JSON.stringify({
            model: 'open-mistral-7b',
            messages: [
              {
                role: 'system',
                content:
                  'Extract a title and description formatted as:\nTitle: <title>\nDescription: <desc>',
              },
              { role: 'user', content: `Text:\n${text}` },
            ],
          }),
        });

        if (!res.ok) {
          if (res.status === 429 && attempt < retries) {
            console.log(
              `Rate limit reached (status 429). Retrying in ${backoff * attempt}ms...`,
            );
            await sleep(backoff * attempt);
            continue;
          }
          console.error(`Mistral API error: ${res.status} ${res.statusText}`);
          throw new HttpException(
            `Mistral API error: ${res.status} ${res.statusText}`,
            HttpStatus.BAD_GATEWAY,
          );
        }

        const payload = (await res.json()) as {
          choices: { message: { content: string } }[];
        };
        console.log('Mistral API response received successfully.');
        return payload.choices?.[0]?.message.content || '';
      } catch (err: any) {
        console.error(
          `Error during Mistral API request: ${(err as Error).message}`,
        );
        if (attempt === retries) {
          console.error('Max retries reached. Throwing error...');
          throw err;
        }
        console.log(`Retrying after ${backoff * attempt}ms due to error...`);
        await sleep(backoff * attempt);
      }
    }

    console.log('Mistral API call failed after maximum retries.');
    return '';
  }
}
