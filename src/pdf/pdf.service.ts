import { Injectable } from '@nestjs/common';
import { join } from 'path';
import * as fs from 'fs';
import * as Poppler from 'pdf-poppler';
import * as tesseract from 'node-tesseract-ocr';
import fetch from 'node-fetch';

/**
 * Summary per page
 */
export interface PageSummary {
  imageUrl: string;
  title: string;
  description: string;
}

@Injectable()
export class PdfService {
  private readonly mistralUrl = 'https://api.mistral.ai/v1/chat/completions';
  private readonly mistralKey = process.env.MISTRAL_API_KEY;

  async convertAndSummarize(pdfPath: string, outputDir: string): Promise<PageSummary[]> {
    // 1. Convert PDF pages to PNG
    await Poppler.convert(pdfPath, {
      format: 'png',
      out_dir: outputDir,
      out_prefix: 'page',
    });

    // 2. Read output files
    const files = fs
      .readdirSync(outputDir)
      .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
      .sort();

    const summaries: PageSummary[] = [];

    for (const file of files) {
      const imagePath = join(outputDir, file);
      const text = await tesseract.recognize(imagePath, { lang: 'eng' });

      // 3. Call Mistral to extract title & description
      const aiResponse = await this.callMistral(text);
      const [titleLine, ...descLines] = aiResponse.split('\n');
      const title = titleLine.replace(/^Title:/i, '').trim();
      const description = descLines.join(' ').replace(/^Description:/i, '').trim();

      summaries.push({
        imageUrl: `http://localhost:3000/files/${file}`,
        title,
        description,
      });
    }

    return summaries;
  }

  private async callMistral(text: string): Promise<string> {
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
            content: 'Extract a title of 5-10 words and a description of 30-40 words from the text. Format as:\nTitle: <title>\nDescription: <description>',
          },
          { role: 'user', content: `Text:\n${text}` },
        ],
      }),
    });
    const { choices } = (await res.json()) as { choices: { message: { content: string } }[] };
    return choices[0]?.message.content || '';
  }
}