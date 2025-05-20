import { Controller, Post, Body, Get, Param, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { WordpressService } from './wordpress.service';
import { PdfService, PageSummary } from '../pdf/pdf.service';

@Controller('wordpress')
export class WordpressController {
  private readonly logger = new Logger(WordpressController.name);

  constructor(
    private readonly wordpressService: WordpressService,
    private readonly pdfService: PdfService
  ) {}

  @Post('map-pdf')
  async mapPdfToTemplates(@Body() body: { pdfPath?: string }) {
    try {
      // Check if we should use the most recently processed PDF
      const recentPdf = this.pdfService.getRecentPdf();
      const pdfPath = body.pdfPath || (recentPdf?.filePath);
      
      if (!pdfPath) {
        throw new HttpException('PDF path is required or no recent PDF available', HttpStatus.BAD_REQUEST);
      }

      // Use the existing PDF service to extract content
      const outputDir = `./output/${Date.now()}`;
      const pdfData: PageSummary[] = await this.pdfService.convertAndSummarize(pdfPath, outputDir);
      
      // Map the extracted PDF data to WordPress templates
      const templateMappings = this.wordpressService.mapPDFToTemplates(pdfData);
      
      return {
        bestMatch: templateMappings[0],
        allMatches: templateMappings,
        pdfData
      };
    } catch (error) {
      this.logger.error(`Error mapping PDF to templates: ${error.message}`);
      throw new HttpException(
        `Failed to map PDF: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * Get information about the most recently processed PDF
   */
  @Get('recent-pdf')
  async getRecentPdf() {
    const recentPdf = this.pdfService.getRecentPdf();
    
    if (!recentPdf) {
      throw new HttpException('No recently processed PDF found', HttpStatus.NOT_FOUND);
    }
    
    return {
      filePath: recentPdf.filePath,
      processedAt: new Date(recentPdf.timestamp),
      pageCount: recentPdf.pageSummaries.length,
      fileHash: recentPdf.fileHash
    };
  }
  
  /**
   * Analyze the most recently processed PDF and map it to WordPress templates
   * No need to specify a PDF path - uses the most recently processed one
   */
  @Post('analyze-recent')
  async analyzeRecentPdf(@Body() body: {
    autoSelectTemplate?: boolean;
    preferredTemplate?: string;
  }) {
    try {
      const { autoSelectTemplate = true, preferredTemplate } = body;
      
      // Get the most recently processed PDF
      const recentPdf = this.pdfService.getRecentPdf();
      
      if (!recentPdf) {
        throw new HttpException('No recently processed PDF found', HttpStatus.NOT_FOUND);
      }
      
      // Map the extracted PDF data to WordPress templates
      const templateMappings = this.wordpressService.mapPDFToTemplates(recentPdf.pageSummaries);
      
      // Determine which template to use
      let selectedMapping = templateMappings[0]; // Default to best match
      
      if (!autoSelectTemplate && preferredTemplate) {
        // Try to find the preferred template
        const preferred = templateMappings.find(m => m.templateName === preferredTemplate);
        if (preferred) {
          selectedMapping = preferred;
        } else {
          this.logger.warn(`Preferred template "${preferredTemplate}" not found, using best match`);
        }
      }
      
      return {
        pdfInfo: {
          filePath: recentPdf.filePath,
          processedAt: new Date(recentPdf.timestamp),
          pageCount: recentPdf.pageSummaries.length
        },
        bestMatch: selectedMapping,
        allMatches: templateMappings
      };
    } catch (error) {
      this.logger.error(`Error analyzing recent PDF: ${error.message}`);
      throw new HttpException(
        `Failed to analyze recent PDF: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
  
  @Post('post-to-wordpress')
  async postToWordPress(@Body() body: { 
    title: string;
    content: string;
    acfFields: Record<string, string>;
    templateName: string;
  }) {
    try {
      const { title, content, acfFields, templateName } = body;
      
      // Validate required fields
      if (!title || !templateName) {
        throw new HttpException('Title and template name are required', HttpStatus.BAD_REQUEST);
      }
      
      // Post to WordPress
      const result = await this.wordpressService.postToWordPress(
        title,
        content,
        acfFields,
        templateName
      );
      
      return {
        success: true,
        wordpressId: result.id,
        permalink: result.link
      };
    } catch (error) {
      this.logger.error(`Error posting to WordPress: ${error.message}`);
      throw new HttpException(
        `Failed to post to WordPress: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  /**
   * One-click endpoint to post the most recently processed PDF to WordPress 
   * using the best matching template
   */
  @Post('post-recent')
  async postRecentPdf(@Body() body: {
    autoSelectTemplate?: boolean;
    preferredTemplate?: string;
  }) {
    try {
      const { autoSelectTemplate = true, preferredTemplate } = body;
      
      // Get the most recently processed PDF
      const recentPdf = this.pdfService.getRecentPdf();
      
      if (!recentPdf) {
        throw new HttpException('No recently processed PDF found', HttpStatus.NOT_FOUND);
      }
      
      // Map the PDF data to WordPress templates
      const templateMappings = this.wordpressService.mapPDFToTemplates(recentPdf.pageSummaries);
      
      // Determine which template to use
      let selectedMapping = templateMappings[0]; // Default to best match
      
      if (!autoSelectTemplate && preferredTemplate) {
        // Try to find the preferred template
        const preferred = templateMappings.find(m => m.templateName === preferredTemplate);
        if (preferred) {
          selectedMapping = preferred;
        } else {
          this.logger.warn(`Preferred template "${preferredTemplate}" not found, using best match`);
        }
      }
      
      // Check if we have all required fields
      if (selectedMapping.missingRequiredFields.length > 0) {
        return {
          success: false,
          message: `Missing required fields for template "${selectedMapping.templateName}": ${selectedMapping.missingRequiredFields.join(', ')}`,
          templateMappings,
          selectedMapping
        };
      }
      
      // Extract title and content from the first page of the PDF
      const firstPage = recentPdf.pageSummaries[0];
      const title = firstPage?.title || 'Extracted from PDF';
      const content = firstPage?.description || 'Content extracted from PDF document';
      
      // Post to WordPress
      const result = await this.wordpressService.postToWordPress(
        title,
        content,
        selectedMapping.mappedFields,
        selectedMapping.templateName
      );
      
      return {
        success: true,
        wordpressId: result.id,
        permalink: result.link,
        template: selectedMapping.templateName,
        matchPercentage: selectedMapping.matchPercentage,
        allTemplates: templateMappings
      };
    } catch (error) {
      this.logger.error(`Error posting recent PDF to WordPress: ${error.message}`);
      throw new HttpException(
        `Failed to post PDF to WordPress: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('analyze-and-post')
  async analyzeAndPost(@Body() body: { 
    pdfPath?: string;
    autoSelectTemplate?: boolean;
    preferredTemplate?: string;
  }) {
    try {
      const { autoSelectTemplate = true, preferredTemplate } = body;
      
      // Check if we should use the most recently processed PDF
      const recentPdf = this.pdfService.getRecentPdf();
      const pdfPath = body.pdfPath || (recentPdf?.filePath);
      
      if (!pdfPath) {
        throw new HttpException('PDF path is required or no recent PDF available', HttpStatus.BAD_REQUEST);
      }
      
      // 1. Process the PDF
      const outputDir = `./output/${Date.now()}`;
      const pdfData: PageSummary[] = await this.pdfService.convertAndSummarize(pdfPath, outputDir);
      
      // 2. Map to templates
      const templateMappings = this.wordpressService.mapPDFToTemplates(pdfData);
      
      // 3. Determine which template to use
      let selectedMapping = templateMappings[0]; // Default to best match
      
      if (!autoSelectTemplate && preferredTemplate) {
        // Try to find the preferred template
        const preferred = templateMappings.find(m => m.templateName === preferredTemplate);
        if (preferred) {
          selectedMapping = preferred;
        } else {
          this.logger.warn(`Preferred template "${preferredTemplate}" not found, using best match`);
        }
      }
      
      // 4. Check if we have all required fields
      if (selectedMapping.missingRequiredFields.length > 0) {
        return {
          success: false,
          message: `Missing required fields for template "${selectedMapping.templateName}": ${selectedMapping.missingRequiredFields.join(', ')}`,
          templateMappings,
          selectedMapping
        };
      }
      
      // 5. Post to WordPress
      const result = await this.wordpressService.postToWordPress(
        pdfData[0]?.title || 'Untitled',
        pdfData[0]?.description || 'No content',
        selectedMapping.mappedFields,
        selectedMapping.templateName
      );
      
      return {
        success: true,
        wordpressId: result.id,
        permalink: result.link,
        template: selectedMapping.templateName,
        matchPercentage: selectedMapping.matchPercentage,
        allTemplates: templateMappings
      };
    } catch (error) {
      this.logger.error(`Error in analyze and post: ${error.message}`);
      throw new HttpException(
        `Failed to analyze and post: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}
