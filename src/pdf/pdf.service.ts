// src/pdf/pdf.service.ts

//@Injectable() marks a class as a provider that can be injected.
//HttpException, HttpStatus help handle errors.
//Logger is used for logging within the app.
import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
//join helps create platform-independent file paths.
//fs: Node.js module to read/write files.
//crypto: Used to create file hashes (useful for caching or detecting duplicates)
import { join } from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

//Poppler is a utility that converts PDF pages into images. It’s essential for OCR, since OCR operates on images, not PDFs.
import * as Poppler from 'pdf-poppler';

//Tesseract is an OCR (Optical Character Recognition) tool. It extracts text from images.
import * as tesseract from 'node-tesseract-ocr';

//Allows making HTTP requests (useful for calling external APIs).
import fetch from 'node-fetch';

//Google Cloud Vision client library.
//It can detect logos, text, faces, objects in images — useful for analyzing PDF content visually.
import { ImageAnnotatorClient } from '@google-cloud/vision';

//sharp is an image processing library.
//Used for resizing, cropping, converting image formats, etc.
import * as sharp from 'sharp';

//exec lets you run shell commands.
//util.promisify(exec) converts callback-based functions into Promises, for easier async handling.
import { exec } from 'child_process';
import * as util from 'util';

//path is similar to join – helps build file paths.
import * as path from 'path';

//pdf-lib is a powerful library to manipulate PDFs — extract embedded images, split pages, etc.
import { PDFDocument } from 'pdf-lib';

//Used to get the number of CPU cores — useful for determining concurrency or processing capacity.
import { cpus } from 'os';

// Cache interfaces
//Tracks which images have been validated (to avoid processing duplicates).
//Key = hash of the image.
//Value = whether that image passed validation.
interface ImageValidationCache {
  [hash: string]: boolean;
}

//Tracks API responses for different types of requests.
interface ApiResponseCache {
  [key: string]: any;
}

//This interface represents a summary of content extracted from one page of a PDF.
export interface PageSummary {
  imageUrl: string;
  title: string;
  description: string;
  embeddedImages: string[];
  logos: string[];
  photos: string[];
  faces: string[];
  scenes: string[];
}


// Helper to limit concurrency for API calls
//maxConcurrent limits how many tasks (e.g., Vision API calls) can run at once.
//running tracks how many are active.
//queue holds pending tasks.
class ConcurrencyManager {
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(private maxConcurrent: number) { }

  //When runTask is called:

  //If the limit is reached, it waits until a slot is free.
  //Once running, it increments the counter.
  //After the task is done, it decrements and starts the next in queue.
  async runTask<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      // Wait until a slot opens up
      await new Promise<void>(resolve => this.queue.push(resolve));
    }

    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next?.();
      }
    }
  }
}

//Marks PdfService as a NestJS provider, meaning it can be injected into other classes (like controllers or other services).
@Injectable()
export class PdfService {
  // Track most recent processed PDF details
  private recentProcessedPdf: {
    filePath: string;
    outputDir: string;
    fileHash: string;
    timestamp: number;
    pageSummaries: PageSummary[];
  } | null = null;
  
  /**
   * Get the most recently processed PDF information
   * @returns Recent PDF info or null if none has been processed
   */
  getRecentPdf() {
    return this.recentProcessedPdf;
  }
  private readonly mistralUrl = 'https://api.mistral.ai/v1/chat/completions';
  private readonly mistralKey = process.env.MISTRAL_API_KEY;

  //Instantiates Google Cloud Vision’s client.
  private readonly visionClient = new ImageAnnotatorClient();
  private readonly processedImageHashes = new Set<string>(); // Track processed image hashes
  private readonly logger = new Logger(PdfService.name);

  // Performance optimizations
  //Tracks which images have been validated (to avoid processing duplicates).
  private validationCache: ImageValidationCache = {};

  //apiCache: Stores responses from Google Vision API to avoid redundant calls.
  private apiCache: ApiResponseCache = {};
  private readonly visionApiManager = new ConcurrencyManager(5); // Limit to 5 concurrent Vision API calls

  // Method for Google Vision API annotation with caching
  private async annotate(

    //Takes an image buffer and an annotation type (e.g. detect logos or objects).
    //Sends the image to Google Cloud Vision.
    //Returns the result with caching and concurrency control.
    imgBuffer: Buffer,
    type: 'LOGO_DETECTION' | 'OBJECT_LOCALIZATION' | 'LABEL_DETECTION'
  ): Promise<any> {
    // Creates a unique hash for each image + annotation type.
    //Checks if a cached result already exists for that combination.
    //If yes, returns it immediately without hitting the API.
    const bufferHash = crypto.createHash('md5').update(imgBuffer).digest('hex');
    const cacheKey = `${type}_${bufferHash}`;

    // Check cache first
    if (this.apiCache[cacheKey]) {
      this.logger.debug(`Using cached Vision API result for type: ${type}`);
      return this.apiCache[cacheKey];
    }

    this.logger.debug(`Starting annotation for type: ${type}`);

    try {
      // Inside the concurrency manager’s runTask:
      //The image buffer is converted to a base64 string.
      //Sent to Google Vision with the specific annotation type.
      //Returns the result when done.

      //Why use runTask:
      //To make sure only 5 Vision calls happen at the same time.
      const result = await this.visionApiManager.runTask(async () => {
        const [annotationResult] = await this.visionClient.annotateImage({
          image: { content: imgBuffer.toString('base64') },
          features: [{ type: type }],
        });
        return annotationResult;
      });

      // Stores the annotation result in cache for future reuse.
      this.apiCache[cacheKey] = result;
      return result;

    } catch (err) {
      this.logger.error(`Error with Vision API: ${(err as Error).message}`);
      return {};
    }
  }

  // Takes a file path (string).
  //Returns a SHA-256 hash of the file's contents as a hex string.
  //Useful for uniquely identifying the file without loading the full contents into memory (very efficient for large PDFs or images).
  public async getFileHash(filePath: string): Promise<string> {
    try {
      //sha256 is a secure hashing algorithm that gives you a unique fingerprint for the file.
      const hash = crypto.createHash('sha256');
      // Create a read stream instead of loading the whole file into memory.
      //Instead of reading the entire file at once (which can be memory-heavy), this creates a stream.
      //Streams read in chunks (e.g., 64KB at a time), which is much more efficient for large files.
      const stream = fs.createReadStream(filePath);

      return new Promise((resolve, reject) => {
        //Every time the stream reads a chunk, it feeds that chunk to the hash.
        //hash.update(data) updates the internal hash state.
        stream.on('data', (data) => hash.update(data));

        //When the stream finishes reading the entire file, hash.digest('hex') finalizes and returns the hash as a hexadecimal string.
        stream.on('end', () => resolve(hash.digest('hex')));

        //If there's an error reading the file, it rejects the promise.
        stream.on('error', reject);
      });
    } catch (err) {
      this.logger.error(`Error calculating file hash: ${(err as Error).message}`);
      throw err;
    }
  }

  //Takes the path of an image file.
  //Returns a unique hash (MD5) representing that image's content.
  //The goal is fast uniqueness checking, not cryptographic security.
  private async getImageHash(imagePath: string): Promise<string> {
    try {
      // For images, we can use a faster algorithm since we just need uniqueness
      //Ideal for comparing images quickly to detect duplicates or reused content.
      const hash = crypto.createHash('md5');

      //Like in your getFileHash, you're reading the image file in chunks, which is memory-efficient.
      const stream = fs.createReadStream(imagePath);

      return new Promise((resolve, reject) => {
        //Reads each chunk of the image and feeds it into the hash function.
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
      });
    } catch (err) {
      this.logger.error(`Error calculating image hash: ${(err as Error).message}`);
      throw err;
    }
  }

  // Optimized image validation with caching
  private async isValidImage(imagePath: string): Promise<boolean> {
    try {
      // Uses getImageHash (based on file contents) to see if this exact image has been processed before.
      const imageHash = await this.getImageHash(imagePath);

      // Check if we've already validated this image
      if (this.validationCache[imageHash] !== undefined) {
        return this.validationCache[imageHash];
      }

      this.logger.debug(`Validating new image: ${path.basename(imagePath)}`);

      // Gets image width and height.
      //Defaulting to 0 ensures the next conditions won't throw errors.
      const metadata = await sharp(imagePath).metadata();
      const { width = 0, height = 0 } = metadata;

      // Skip very small images
      if (width < 50 || height < 50) {
        this.logger.debug(`Image too small: ${width}x${height}`);
        this.validationCache[imageHash] = false;
        return false;
      }

      // Skip images with extreme aspect ratios
      const aspectRatio = width / height;
      if (aspectRatio > 5 || aspectRatio < 0.2) {
        this.logger.debug(`Extreme aspect ratio: ${aspectRatio}`);
        this.validationCache[imageHash] = false;
        return false;
      }

      // For more expensive validation, use a sample of the image if it's large
      // This significantly improves performance for large images
      let imgToProcess = imagePath;
      let tempResized = '';

      if (width > 1000 || height > 1000) {
        // Resize to a smaller sample for faster processing
        const tempFilePath = `${imagePath}.sample.jpg`;
        await sharp(imagePath)
          .resize(500, 500, { fit: 'inside' })
          .toFile(tempFilePath);
        imgToProcess = tempFilePath;
        tempResized = tempFilePath;
      }

      // Get image data for analysis
      //Reads the raw RGB data of the image into a buffer for analysis.
      const imageInfo = await sharp(imgToProcess)
        .raw()
        .toBuffer({ resolveWithObject: true });

      const data = imageInfo.data;

      // Sample the data if it's too large (for faster calculation)
      const sampleStep = Math.max(1, Math.floor(data.length / 10000));
      const sampledData: number[] = [];
      for (let i = 0; i < data.length; i += sampleStep) {
        sampledData.push(data[i]);
      }

      // Calculate average pixel value from the sample
      const avg = sampledData.reduce((sum, val) => sum + val, 0) / sampledData.length;

      // Calculate standard deviation to detect contrast (using sample)
      let sumSquareDiff = 0;
      for (const val of sampledData) {
        sumSquareDiff += Math.pow(val - avg, 2);
      }

      //Standard Deviation is a measure of the amount of variation or dispersion of a set of values.
      const stdDev = Math.sqrt(sumSquareDiff / sampledData.length);

      // Clean up any temporary file we created
      if (tempResized && fs.existsSync(tempResized)) {
        fs.unlinkSync(tempResized);
      }

      // Check quality criteria
      const isValid = avg > 10 && avg < 245 && stdDev > 15;

      // Cache the result
      this.validationCache[imageHash] = isValid;

      return isValid;
    } catch (err) {
      this.logger.error(`Error validating image ${imagePath}: ${(err as Error).message}`);
      return false;
    }
  }

  // Cache tool availability results to avoid repeated checks
  private toolAvailabilityCache: Record<string, boolean> = {};
  private readonly execAsync = util.promisify(exec);

  private async checkToolAvailability(tool: string): Promise<boolean> {
    // Check cache first
    //If we've already checked this tool, return the cached result instead of checking again.
    if (this.toolAvailabilityCache[tool] !== undefined) {
      return this.toolAvailabilityCache[tool];
    }

    this.logger.debug(`Checking availability of ${tool}...`);
    try {

      //Most CLI tools return help text and exit 0 when run with -h (or --help).
      //This avoids actual processing or long waits.
      //2-second timeout prevents hanging if a tool is buggy.
      await this.execAsync(`${tool} -h`, { timeout: 2000 });
      this.logger.debug(`${tool} is available`);

      //Caches the result.
      this.toolAvailabilityCache[tool] = true;
      return true;

    } catch (e) {
      this.logger.debug(`${tool} is not available: ${(e as Error).message}`);
      this.toolAvailabilityCache[tool] = false;
      return false;
    }
  }

  private async extractWithNativeTools(
    pdfPath: string,
    outputDir: string
  ): Promise<boolean> {
    this.logger.debug(`Attempting to extract images using native tools`);
    const imgPrefix = join(outputDir, 'embedded');

    // Run both tools in parallel if available
    //Stores promises for each extraction task.
    const extractionTasks: Promise<void>[] = [];

    // Check tool availability in parallel
    //Checks whether each tool exists only once, using the cached check logic.
    const [pdfimagesAvailable, pdftocairoAvailable] = await Promise.all([
      this.checkToolAvailability('pdfimages'),
      this.checkToolAvailability('pdftocairo')
    ]);

    // 1) Extract bitmaps via pdfimages if available
    const successFlags: boolean[] = [];

    if (pdfimagesAvailable) {
      extractionTasks.push(
        this.execAsync(`pdfimages -all "${pdfPath}" "${imgPrefix}"`)
          .then(() => {
            this.logger.debug('pdfimages extraction completed successfully');
            successFlags.push(true);
          })
          .catch(err => {
            this.logger.error(`Error running pdfimages: ${err.message}`);
            successFlags.push(false);
          })
      );
    }

    if (pdftocairoAvailable) {
      extractionTasks.push(
        this.execAsync(`pdftocairo -svg "${pdfPath}" "${imgPrefix}"`)
          .then(() => {
            this.logger.debug('pdftocairo extraction completed successfully');
            successFlags.push(true);
          })
          .catch(err => {
            this.logger.error(`Error running pdftocairo: ${err.message}`);
            successFlags.push(false);
          })
      );
    }

    if (extractionTasks.length > 0) {
      await Promise.allSettled(extractionTasks);
    }

    return successFlags.includes(true);

  }

  private async extractEmbeddedImages(
    //pdfPath: Path to the input PDF file.
    //outputDir: Where to save extracted images.
    //fileHash: Unique identifier used to generate unique file paths for frontend access (like /files/:hash/:filename).
    pdfPath: string,
    outputDir: string,
    fileHash: string,
  ): Promise<string[]> {
    this.logger.log(`Extracting embedded images from PDF: ${path.basename(pdfPath)}`);

    //Prepare an array to collect valid image URLs to return.
    const validImagePaths: string[] = [];

    try {
      // Create embedded images subdirectory to separate from rendered pages
      const embeddedDir = join(outputDir, 'embedded');
      await fs.promises.mkdir(embeddedDir, { recursive: true });

      // First try using pdf-lib for direct extraction
      const pdfBytes = await fs.promises.readFile(pdfPath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      this.logger.debug(`PDF loaded with ${pdfDoc.getPageCount()} pages using pdf-lib`);

      // Create a local processed hashes set for this PDF only
      const processedImageHashes = new Set<string>();

      // Check platform and run extraction methods in parallel when possible
      const isWindows = process.platform === 'win32';
      this.logger.debug(`Running on ${isWindows ? 'Windows' : 'non-Windows'} platform`);

      let nativeSuccess = false;

      // Create a type for the extraction promises
      type ExtractionPromiseResult = boolean;
      const extractionPromises: Promise<ExtractionPromiseResult>[] = [];

      // Try native tools if appropriate for platform - prioritized
      // Set a timeout to ensure we don't wait too long
      const extractionTimeout = 60000; // 60 seconds max for extraction
      const timeoutPromise = new Promise<boolean>((resolve) => {
        setTimeout(() => {
          this.logger.warn('Extraction timeout reached');
          resolve(false);
        }, extractionTimeout);
      });

      // Try native tools if appropriate for platform
      if (!isWindows || (await this.checkToolAvailability('pdfimages'))) {
        extractionPromises.push(
          Promise.race([
            this.extractWithNativeTools(pdfPath, embeddedDir)
              .then(success => {
                nativeSuccess = success;
                return success as ExtractionPromiseResult;
              }),
            timeoutPromise
          ])
        );
      }

      // Wait for all extraction methods to complete
      await Promise.all(extractionPromises);



      // Once extraction is complete, find and process all image files
      // We'll do this in batches to avoid overwhelming the system
      this.logger.debug('Finding all extracted image files');
      const files = fs
        .readdirSync(embeddedDir)
        .filter((f) =>
          // include PNG/JPG/JP2/TIFF bitmaps and SVG vectors
          /\.(png|jpe?g|jp2?|tiff?|svg)$/i.test(f),
        )
        .sort();

      this.logger.debug(`Found ${files.length} raw embedded assets`);

      // Check if extraction didn't find anything - this might indicate a failure
      if (files.length === 0) {
        this.logger.warn('No embedded images found with direct extraction methods');
        return [];
      }

      // Process files in parallel batches
      const batchSize = 10; // Process 10 files at a time
      const totalBatches = Math.ceil(files.length / batchSize);

      for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const startIdx = batchIndex * batchSize;
        const endIdx = Math.min(startIdx + batchSize, files.length);
        const batch = files.slice(startIdx, endIdx);

        this.logger.debug(`Processing batch ${batchIndex + 1}/${totalBatches} (${batch.length} files)`);

        // Process all files in this batch in parallel
        const batchResults = await Promise.all(
          batch.map(async (file) => {
            const fullPath = join(embeddedDir, file);
            try {
              // Skip files that look like page renderings
              if (file.startsWith('page-') || file.match(/^page\d+/)) {
                this.logger.debug(`Skipping page rendering: ${file}`);
                return null;
              }

              // Quick type check first - SVGs can skip some validation
              const isSvg = /\.svg$/i.test(file);
              const isBitmap = /\.(png|jpe?g|jp2?|tiff?)$/i.test(file);

              // Generate a hash to identify duplicate images
              const imageHash = await this.getImageHash(fullPath);

              // Skip if we've already processed this image
              if (processedImageHashes.has(imageHash)) {
                this.logger.debug(`Skipping duplicate image with hash ${imageHash.substring(0, 8)}...`);
                return null; // Skip this image
              }

              processedImageHashes.add(imageHash);

              // For SVGs, we can skip some validation
              if (isSvg) {
                this.logger.debug(`Including vector graphic: ${file}`);
                // Use file directly from the embedded directory
                return `/files/${fileHash}/embedded/${file}`;
              }

              // For bitmaps, apply size check and validation
              if (isBitmap) {
                // Quick size check with sharp
                const { width = 0, height = 0 } = await sharp(fullPath).metadata();

                // Skip tiny images immediately
                if (width < 50 || height < 50) {
                  this.logger.debug(`Skipping small bitmap: ${file} (${width}×${height})`);
                  return null; // Skip this image
                }

                // Additional filter to avoid page renderings
                const aspectRatio = width / height;
                if (aspectRatio > 0.95 && aspectRatio < 1.05 && width > 500 && height > 500) {
                  // Square images with large dimensions are often full page renders
                  const pixelDensity = await this.checkImagePixelDensity(fullPath);
                  if (pixelDensity < 0.1) { // Very low density suggests a background/page
                    this.logger.debug(`Skipping likely page background: ${file}`);
                    return null;
                  }
                }

                // Full validation check
                if (await this.isValidImage(fullPath)) {
                  this.logger.debug(`Valid embedded image: ${file}`);
                  // Use file directly from the embedded directory
                  return `/files/${fileHash}/embedded/${file}`;
                } else {
                  this.logger.debug(`Image failed validation: ${file}`);
                }
              }

              return null; // Skip if didn't pass validation
            } catch (err) {
              this.logger.error(`Error processing file ${file}: ${(err as Error).message}`);
              return null;
            }
          })
        );

        // Filter out null results and add valid paths
        validImagePaths.push(...batchResults.filter(Boolean) as string[]);
      }
    } catch (err) {
      this.logger.error(`Error extracting embedded images: ${(err as Error).message}`);
    }

    this.logger.log(`Extracted ${validImagePaths.length} valid embedded images/vectors`);
    return validImagePaths;
  }

  // Helper method to check image pixel density (useful for distinguishing 
  // backgrounds/page renders from actual content images)
  private async checkImagePixelDensity(imagePath: string): Promise<number> {
    try {
      // Get a sample of the image
      const { data, info } = await sharp(imagePath)
        .resize(100, 100, { fit: 'inside' }) // Sample at smaller size for speed
        .raw()
        .toBuffer({ resolveWithObject: true });

      // Count non-white/non-background pixels
      let nonBackgroundPixels = 0;
      const threshold = 240; // Threshold for considering a pixel as background

      for (let i = 0; i < data.length; i += info.channels) {
        // Check if the pixel is not near-white (background)
        const isBackground = data[i] > threshold &&
          (info.channels < 2 || data[i + 1] > threshold) &&
          (info.channels < 3 || data[i + 2] > threshold);

        if (!isBackground) {
          nonBackgroundPixels++;
        }
      }

      // Calculate density as percentage of non-background pixels
      const totalPixels = (data.length / info.channels);
      return nonBackgroundPixels / totalPixels;
    } catch (err) {
      this.logger.error(`Error checking image density: ${(err as Error).message}`);
      return 0.5; // Return middle value on error
    }
  }


  // Second callMistral implementation removed - using the more robust one below

  async convertAndSummarize(
    pdfPath: string,
    outputDir: string,
  ): Promise<PageSummary[]> {
    // Start timer to measure performance improvements
    const startTime = Date.now();

    this.logger.log(`Starting PDF processing: ${path.basename(pdfPath)}`);
    const fileHash = await this.getFileHash(pdfPath);
    this.logger.debug(`Generated file hash: ${fileHash}`);

    // Reset the caches to free memory
    this.processedImageHashes.clear();
    this.validationCache = {};
    this.apiCache = {};

    // Clear and recreate directory
    this.logger.debug(`Preparing output directory: ${outputDir}`);
    await fs.promises.rm(outputDir, { recursive: true, force: true });
    await fs.promises.mkdir(outputDir, { recursive: true });

    // Run embedded image extraction and PDF conversion in parallel
    this.logger.log('Starting extraction processes in parallel...');

    // Run both operations in parallel but handle them separately
    const embeddedImagesPromise = this.extractEmbeddedImages(pdfPath, outputDir, fileHash);
    const pdfConversionPromise = Poppler.convert(pdfPath, {
      format: 'png',
      out_dir: outputDir,
      out_prefix: 'page',
    });

    // Wait for both operations to complete
    const embeddedImages = await embeddedImagesPromise;
    await pdfConversionPromise;

    this.logger.log(`Extracted ${embeddedImages.length} embedded images`);

    // Find all rendered pages
    const pages = fs
      .readdirSync(outputDir)
      .filter((f) => f.startsWith('page-') && f.endsWith('.png'))
      .sort();

    this.logger.log(`Found ${pages.length} page(s) to process`);

    // Skip duplicate pages by hash
    const pageHashes = new Set<string>();
    const validPages: { index: number, file: string, imagePath: string }[] = [];

    // Pre-process pages to filter duplicates - do this in parallel
    await Promise.all(pages.map(async (file, i) => {
      const imagePath = join(outputDir, file);
      try {
        // Quick validation first
        const isValid = await this.isValidImage(imagePath);
        if (!isValid) return;

        // Check for duplicates
        const imageHash = await this.getImageHash(imagePath);
        if (pageHashes.has(imageHash)) return;

        pageHashes.add(imageHash);
        validPages.push({ index: i, file, imagePath });
      } catch (err) {
        this.logger.error(`Error preprocessing page ${file}: ${(err as Error).message}`);
      }
    }));

    this.logger.log(`Processing ${validPages.length} unique pages (excluded ${pages.length - validPages.length} duplicates)`);

    // Define maximum concurrent operations
    const maxConcurrentPages = Math.max(1, Math.min(3, Math.floor(cpus().length / 2)));
    this.logger.debug(`Using ${maxConcurrentPages} concurrent page processing threads`);

    // Process pages in batches for parallelism while avoiding memory issues
    const summaries: PageSummary[] = [];

    // Process pages in batches
    for (let i = 0; i < validPages.length; i += maxConcurrentPages) {
      const batch = validPages.slice(i, i + maxConcurrentPages);
      this.logger.debug(`Processing batch of ${batch.length} pages`);

      const batchResults = await Promise.all(batch.map(async ({ index, file, imagePath }) => {
        try {
          this.logger.debug(`Processing page ${index + 1}/${pages.length}: ${file}`);

          // Run OCR and AI analysis in parallel with image feature detection
          const [textAnalysis, imageFeatures] = await Promise.all([
            // Text extraction and AI analysis
            this.extractAndAnalyzeText(imagePath, file),

            // Feature detection for logos, photos, etc.
            this.detectAndCropLogos(imagePath, outputDir, file, fileHash)
          ]);

          // If text analysis failed, skip this page
          if (!textAnalysis) return null;

          const { title, description } = textAnalysis;
          const { logos, photos, faces, scenes } = imageFeatures;

          this.logger.debug(
            `Page ${file}: ${logos.length} logos, ${photos.length} photos, ${faces.length} faces, ${scenes.length} scenes`
          );

          return {
            imageUrl: `/files/${fileHash}/${file}`,
            title,
            description,
            embeddedImages: index === 0 ? embeddedImages : [], // Only include on first page
            logos,
            photos,
            faces,
            scenes,
          };
        } catch (err) {
          this.logger.error(`Error processing page ${file}: ${(err as Error).message}`);
          return null;
        }
      }));

      // Add successful results to summaries
      summaries.push(...batchResults.filter(Boolean) as PageSummary[]);
    }

    const processingTime = (Date.now() - startTime) / 1000;
    this.logger.log(`PDF processing completed in ${processingTime.toFixed(1)}s with ${summaries.length} pages`);
    
    // Store this as the most recently processed PDF for future WordPress integrations
    this.recentProcessedPdf = {
      filePath: pdfPath,
      outputDir,
      fileHash,
      timestamp: Date.now(),
      pageSummaries: summaries
    };
    
    return summaries;
  }

  // Helper method to extract and analyze text with OCR and AI
  private async extractAndAnalyzeText(imagePath: string, filename: string): Promise<{ title: string, description: string } | null> {
    try {
      this.logger.debug(`Extracting text from ${filename}`);
      const text = await tesseract.recognize(imagePath, { lang: 'eng' });
      const trimmedText = text.trim();

      if (!trimmedText) {
        this.logger.debug(`No text found on page: ${filename}`);
        return null;
      }

      this.logger.debug(`Analyzing text with AI: ${filename}`);
      return await this.callMistral(trimmedText);
    } catch (err) {
      this.logger.error(`Text extraction error for ${filename}: ${(err as Error).message}`);
      return null;
    }
  }

  // This function is intentionally left empty as it's a duplicate of the more robust annotate implementation below

  private async detectAndCropLogos(
    imagePath: string,
    outputDir: string,
    pageFilename: string,
    fileHash: string,
  ): Promise<{ logos: string[]; photos: string[]; faces: string[]; scenes: string[] }> {
    this.logger.log(`Starting logo and photo detection for image: ${path.basename(imagePath)}`);

    const imgBuffer = fs.readFileSync(imagePath);
    const logos: string[] = [];
    const photos: string[] = [];
    const faces: string[] = []; // Keep empty array for backwards compatibility
    const scenes: string[] = [];

    try {
      this.logger.debug('Starting logo detection...');
      const logoResp: any = await this.annotate(imgBuffer, 'LOGO_DETECTION');
      const { width: imgW = 0, height: imgH = 0 } =
        await sharp(imgBuffer).metadata();
      this.logger.debug(`Image dimensions: ${imgW}x${imgH}`);

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
        this.logger.debug(
          `Extracting logo ${idx} with dimensions: ${width}x${height} at (${left}, ${top})`,
        );
        await sharp(imgBuffer)
          .extract({ left, top, width, height })
          .toFile(outputPath);

        logos.push(
          `/files/${fileHash}/${pageFilename.replace('.png', '')}_logo_${idx}.png`,
        );
      }
      this.logger.debug(`Detected ${logos.length} logos.`);
    } catch (error) {
      this.logger.error('Logo detection failed:', (error as Error).message);
    }

    try {
      this.logger.debug('Starting object detection...');
      const objResp: any = await this.annotate(
        imgBuffer,
        'OBJECT_LOCALIZATION',
      );
      const { width: W = 0, height: H = 0 } = await sharp(imgBuffer).metadata();
      this.logger.debug(`Image dimensions for object detection: ${W}x${H}`);

      // Define photo-related object categories
      const photoCategories = [
        'Person', 'Human', 'Man', 'Woman', 'Child', 'People', 'Group',
        'Photograph', 'Picture frame', 'Image', 'Portrait', 'Photo',
        'Animal', 'Pet', 'Dog', 'Cat', 'Bird', 'Wildlife',
        'Scenery', 'Landscape', 'Building', 'Architecture', 'Landmark'
      ];

      // Track the areas we've already processed to avoid overlapping extractions
      const processedAreas: Array<{ left: number, top: number, width: number, height: number }> = [];

      for (const [idx, ann] of (
        objResp.localizedObjectAnnotations || []
      ).entries()) {
        const verts = ann.boundingPoly?.normalizedVertices;
        if (!verts || verts.length < 3) continue;

        // Check if the object is likely a photo
        const objectName = ann.name || '';
        const score = ann.score || 0;
        const isLikelyPhoto = photoCategories.some(cat =>
          objectName.toLowerCase().includes(cat.toLowerCase())
        ) || score > 0.7;

        // Skip if not likely a photo and not high confidence
        if (!isLikelyPhoto && score < 0.8) continue;

        // Calculate bounding box with normalized coordinates (0-1 range)
        const xs = verts.map((v: any) => Math.max(0, Math.min(1, v.x || 0)));
        const ys = verts.map((v: any) => Math.max(0, Math.min(1, v.y || 0)));
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const maxX = Math.max(...xs);
        const maxY = Math.max(...ys);

        // Convert to pixel coordinates
        const left = Math.max(0, Math.round(minX * W));
        const top = Math.max(0, Math.round(minY * H));
        const width = Math.min(W - left, Math.round((maxX - minX) * W));
        const height = Math.min(H - top, Math.round((maxY - minY) * H));

        // Skip very small objects (likely not photos)
        if (width < 50 || height < 50) {
          this.logger.debug(`Skipping small object: ${width}x${height}`);
          continue;
        }

        // Skip if aspect ratio is extreme
        const aspectRatio = width / height;
        if (aspectRatio > 5 || aspectRatio < 0.2) {
          this.logger.debug(`Skipping object with extreme aspect ratio: ${aspectRatio}`);
          continue;
        }

        // Check if this area overlaps significantly with an already processed area
        const overlapsExisting = processedAreas.some(area => {
          const xOverlap = Math.max(0, Math.min(area.left + area.width, left + width) - Math.max(area.left, left));
          const yOverlap = Math.max(0, Math.min(area.top + area.height, top + height) - Math.max(area.top, top));
          const overlapArea = xOverlap * yOverlap;
          const thisArea = width * height;
          const existingArea = area.width * area.height;
          // Skip if overlap is more than 70% of either area
          return overlapArea > 0.7 * Math.min(thisArea, existingArea);
        });

        if (overlapsExisting) {
          this.logger.debug(`Skipping overlapping object at (${left},${top}) with size ${width}x${height}`);
          continue;
        }

        // Add padding to capture more context
        const padX = Math.round(width * 0.1);
        const padY = Math.round(height * 0.1);
        const paddedLeft = Math.max(0, left - padX);
        const paddedTop = Math.max(0, top - padY);
        const paddedWidth = Math.min(W - paddedLeft, width + padX * 2);
        const paddedHeight = Math.min(H - paddedTop, height + padY * 2);

        // Record this area as processed
        processedAreas.push({ left: paddedLeft, top: paddedTop, width: paddedWidth, height: paddedHeight });

        const outName = `${pageFilename.replace('.png', '')}_obj_${idx}.png`;
        this.logger.debug(
          `Extracting object ${idx} (${objectName}) with dimensions: ${paddedWidth}x${paddedHeight} at (${paddedLeft}, ${paddedTop})`,
        );

        try {
          const outputPath = join(outputDir, outName);
          await sharp(imgBuffer)
            .extract({ left: paddedLeft, top: paddedTop, width: paddedWidth, height: paddedHeight })
            .toFile(outputPath);

          // Verify the extracted image exists and is valid
          if (fs.existsSync(outputPath) && await this.isValidImage(outputPath)) {
            photos.push(`/files/${fileHash}/${outName}`);
            this.logger.debug(`Successfully extracted and validated photo: ${outName}`);
          } else {
            this.logger.debug(`Extracted image failed validation: ${outName}`);
            if (fs.existsSync(outputPath)) {
              fs.unlinkSync(outputPath);
            }
          }
        } catch (extractError) {
          this.logger.error(`Error extracting object: ${(extractError as Error).message}`);
        }
      }
      this.logger.debug(`Detected ${photos.length} photos from objects.`);
    } catch (error) {
      this.logger.error('Object detection failed:', (error as Error).message);
    }

    // Face detection section removed to improve performance

    // Scene detection to find landscape photos
    try {
      this.logger.debug('Starting scene detection...');
      const labelResp: any = await this.annotate(imgBuffer, 'LABEL_DETECTION');
      const { width: imgWidth = 0, height: imgHeight = 0 } = await sharp(imgBuffer).metadata();

      // Define scene-related categories with higher specificity
      const sceneCategories = {
        nature: ['landscape', 'scenery', 'nature', 'outdoor', 'beach', 'mountain', 'forest', 'lake', 'ocean', 'river', 'sky', 'sunset', 'sunrise', 'clouds', 'field', 'garden', 'park', 'trees', 'waterfall', 'valley', 'hill', 'desert'],
        urban: ['building', 'architecture', 'landmark', 'cityscape', 'urban', 'city', 'skyline', 'street', 'downtown', 'monument', 'tower', 'bridge', 'skyscraper'],
        interior: ['room', 'interior', 'indoor', 'furniture', 'office', 'home', 'house', 'apartment', 'hotel', 'restaurant', 'museum', 'gallery']
      };

      // Only process if we have high confidence scene labels
      const sceneLabels = (labelResp.labelAnnotations || [])
        .filter((label: any) => {
          const score = label.score || 0;
          const description = (label.description || '').toLowerCase();

          // Check if the label matches any scene category
          const isNatureScene = sceneCategories.nature.some(term => description.includes(term));
          const isUrbanScene = sceneCategories.urban.some(term => description.includes(term));
          const isInteriorScene = sceneCategories.interior.some(term => description.includes(term));

          const isSceneLabel = isNatureScene || isUrbanScene || isInteriorScene;
          return isSceneLabel && score > 0.75; // Higher confidence threshold
        });

      this.logger.debug(`Found ${sceneLabels.length} scene labels: ${sceneLabels.map((l: any) => l.description).join(', ')}`);

      if (sceneLabels.length > 0) {
        // Instead of copying the whole page, try to identify the scenic portion
        // First check if we already have a crop from object detection that might be a scene
        const existingSceneCrop = photos.some(photoPath => {
          // Check if any of the detected objects is large enough to be a scene
          const filename = path.basename(photoPath);
          return filename.includes('_obj_') &&
            filename.startsWith(pageFilename.replace('.png', ''));
        });

        if (!existingSceneCrop) {
          // If no existing scene crop, create one by analyzing the image
          // For simplicity, we'll use a smart cropping approach
          const outName = `${pageFilename.replace('.png', '')}_scene.png`;
          const outputPath = join(outputDir, outName);

          try {
            // Use sharp's attention strategy to focus on the interesting part of the image
            // This is better than just copying the whole page
            const cropData = await sharp(imgBuffer)
              .metadata()
              .then(metadata => {
                // Calculate a reasonable crop size (not the full page)
                const cropWidth = Math.min(metadata.width || 0, 1200); // Limit max width
                const cropHeight = Math.min(metadata.height || 0, 1200); // Limit max height

                // Use a 3:2 or 16:9 aspect ratio if possible
                const targetRatio = 3 / 2; // Landscape photo ratio
                const currentRatio = cropWidth / cropHeight;

                let finalWidth = cropWidth;
                let finalHeight = cropHeight;

                if (currentRatio > targetRatio) {
                  // Image is wider than target ratio
                  finalWidth = Math.round(finalHeight * targetRatio);
                } else {
                  // Image is taller than target ratio
                  finalHeight = Math.round(finalWidth / targetRatio);
                }

                return { width: finalWidth, height: finalHeight };
              });

            // Use attention strategy to focus on the interesting part
            await sharp(imgBuffer)
              .resize({
                width: cropData.width,
                height: cropData.height,
                fit: 'cover',
                position: 'attention' // This uses image content to determine the crop position
              })
              .toFile(outputPath);

            // Verify the extracted image is valid
            if (fs.existsSync(outputPath) && await this.isValidImage(outputPath)) {
              scenes.push(`/files/${fileHash}/${outName}`);
              this.logger.debug(`Successfully extracted scene: ${outName}`);
              this.logger.debug(`Scene labels: ${sceneLabels.map((l: any) => `${l.description} (${l.score})`).join(', ')}`);
            } else {
              this.logger.debug(`Extracted scene failed validation`);
              if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
              }
            }
          } catch (error) {
            this.logger.error(`Error extracting scene: ${(error as Error).message}`);
          }
        } else {
          this.logger.debug(`Using existing object detection as scene image`);
        }
      }

      this.logger.debug(`Detected ${scenes.length} scenes.`);
    } catch (error) {
      this.logger.error('Scene detection failed:', (error as Error).message);
    }

    this.logger.log(
      `Detection complete. Found ${logos.length} logos, ${photos.length} photos, and ${scenes.length} scenes.`,
    );
    
    return { logos, photos, faces, scenes };
  }

  private async callMistral(
    text: string,
    retries = 3,
    backoff = 1000,
  ): Promise<{ title: string; description: string }> {
    if (!this.mistralKey) {
      console.error('MISTRAL_API_KEY is missing.');
      throw new HttpException(
        'Missing MISTRAL_API_KEY',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const systemPrompt = `
  You are a lead generation and sales opportunity analyzer.
  1. Extract the single most compelling **title** that would attract potential leads (no more than 10 words).
  2. For the **description**, analyze the content for:
     - Value propositions and unique selling points
     - Potential pain points the product/service solves
     - Target audience indicators and qualification information
     - Call-to-action elements
     - Contact information or ways to engage
     - Key metrics, statistics, or results that demonstrate value
  3. Format the description as a concise, persuasive 2-3 sentence summary optimized for lead generation.
  4. Return ONLY valid JSON with fields "title" and "description", e.g.:
  
  {
    "title": "Boost Revenue 35% with AI-Powered Analytics",
    "description": "Our enterprise solution helps finance teams reduce reporting time by 75% while identifying 30% more revenue opportunities. Schedule a demo today to see how our AI technology can transform your data workflow and deliver immediate ROI."
  }
  `.trim();

    const userPrompt = `
  Text:
  ${text}
  `.trim();

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(this.mistralUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.mistralKey}`,
          },
          body: JSON.stringify({
            model: 'open-mistral-7b',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          }),
        });

        if (!res.ok) {
          if (res.status === 429 && attempt < retries) {
            console.warn(
              `Rate-limited (429); retrying in ${backoff * attempt}ms…`,
            );
            await new Promise((r) => setTimeout(r, backoff * attempt));
            continue;
          }
          throw new HttpException(
            `Mistral API error: ${res.status} ${res.statusText}`,
            HttpStatus.BAD_GATEWAY,
          );
        }

        const payload = (await res.json()) as {
          choices: { message: { content: string } }[];
        };
        const content = payload.choices?.[0]?.message.content?.trim() || '';

        // Attempt to parse clean JSON out of the content
        let data: { title: string; description: string };
        try {
          // In case the model wraps JSON in backticks or markdown fences
          const jsonText = content
            .replace(/```json\s*([\s\S]*?)```/, '$1')
            .replace(/```([\s\S]*?)```/, '$1')
            .trim();
          data = JSON.parse(jsonText);
        } catch (parseErr) {
          console.error('Failed to parse JSON from Mistral:', content);
          throw new HttpException(
            'Invalid JSON from Mistral',
            HttpStatus.BAD_GATEWAY,
          );
        }

        return {
          title: data.title.trim(),
          description: data.description.trim(),
        };
      } catch (err) {
        console.error(
          `Mistral attempt ${attempt} error:`,
          (err as Error).message,
        );
        if (attempt === retries) {
          throw new HttpException(
            'Failed to get title/description from Mistral after retries',
            HttpStatus.BAD_GATEWAY,
          );
        }
        await new Promise((r) => setTimeout(r, backoff * attempt));
      }
    }

    // Unreachable
    return { title: '', description: '' };
  }
}