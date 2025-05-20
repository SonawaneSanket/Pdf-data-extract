import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import fetch from 'node-fetch';
import { PageSummary } from '../pdf/pdf.service';

// WordPress template definitions
interface ACFTemplateField {
  name: string;
  required: boolean;
}

interface WordPressTemplate {
  name: string;
  fields: ACFTemplateField[];
}

// Template mapping result  
export interface TemplateMapping {
  templateName: string;
  mappedFields: Record<string, string>;
  matchPercentage: number;
  missingRequiredFields: string[];
}

@Injectable()
export class WordpressService {
  private readonly logger = new Logger(WordpressService.name);
  private readonly wpBaseUrl: string = 'https://publishers.clarovate.io/wp-json/wp/v2';
  private readonly wpUsername: string = 'webmaster';
  private readonly wpPassword: string = 'JvRj hcXt cJS2 0PWN opMQ MPew';

  // Define the template structures
  private readonly templates: WordPressTemplate[] = [
    {
      name: 'default',
      fields: [
        { name: 'site_logo', required: false },
        { name: 'title_text', required: true },
        { name: 'paragraph_text', required: true },
        { name: 'form_title', required: false },
        { name: 'new_section_image', required: false },
        { name: 'new_section_title', required: false },
        { name: 'new_section_paragraph', required: false },
        { name: 'footer_logo', required: false }
      ]
    },
    {
      name: 'modern',
      fields: [
        { name: 'site_logo', required: false },
        { name: 'client_company_logo', required: false },
        { name: 'title_text', required: true },
        { name: 'paragraph_text', required: true },
        { name: 'form_title', required: false },
        { name: 'new_section_image', required: false },
        { name: 'new_section_title', required: false },
        { name: 'new_section_paragraph', required: false },
        { name: 'about_us_title', required: false },
        { name: 'about_us_paragraph', required: false },
        { name: 'about_us_button_link', required: false },
        { name: 'about_us_button_text', required: false },
        { name: 'footer_logo', required: false }
      ]
    },
    {
      name: 'minimal',
      fields: [
        { name: 'site_logo', required: false },
        { name: 'client_company_logo', required: false },
        { name: 'about_us_title', required: false },
        { name: 'about_us_paragraph', required: false },
        { name: 'about_us_button_link', required: false },
        { name: 'about_us_button_text', required: false },
        { name: 'title_text', required: true },
        { name: 'paragraph_text', required: true },
        { name: 'new_section_image', required: false },
        { name: 'our_clients_title', required: false },
        { name: 'client_logo_1', required: false },
        { name: 'client_logo_2', required: false },
        { name: 'client_logo_3', required: false },
        { name: 'client_logo_4', required: false },
        { name: 'client_logo_5', required: false },
        { name: 'form_title', required: false },
        { name: 'new_section_title', required: false },
        { name: 'new_section_paragraph', required: false }
      ]
    }
  ];

  /**
   * Maps PDF extracted content to WordPress template fields
   * @param pdfData Extracted PDF content
   * @returns Mapping results for all templates with match percentages
   */
  mapPDFToTemplates(pdfData: PageSummary[]): TemplateMapping[] {
    const templateMappings: TemplateMapping[] = [];
    
    // Analyze PDF data to create a consolidated set of data to map
    const consolidatedData = this.consolidatePDFData(pdfData);

    // Try mapping to each template
    for (const template of this.templates) {
      const mapping = this.mapToTemplate(template, consolidatedData);
      templateMappings.push(mapping);
    }

    // Sort by match percentage descending
    return templateMappings.sort((a, b) => b.matchPercentage - a.matchPercentage);
  }

  /**
   * Consolidates PDF data from multiple pages into a single mapping-ready structure
   */
  private consolidatePDFData(pdfData: PageSummary[]): Record<string, any> {
    // This consolidation logic can be adjusted based on your specific needs
    const consolidated: Record<string, any> = {
      // Text content
      title_text: '',
      paragraph_text: '',
      about_us_title: '',
      about_us_paragraph: '',
      new_section_title: '',
      new_section_paragraph: '',
      form_title: 'Contact Us',
      our_clients_title: 'Our Clients',
      
      // Images
      site_logo: '',
      client_company_logo: '',
      new_section_image: '',
      footer_logo: '',
      client_logo_1: '',
      client_logo_2: '',
      client_logo_3: '',
      client_logo_4: '',
      client_logo_5: '',
      
      // Links
      about_us_button_link: '#',
      about_us_button_text: 'Learn More'
    };

    if (pdfData.length === 0) return consolidated;
    
    // First search for embedded images across ALL pages
    // This is the highest priority for images since they are directly from the PDF structure
    const allEmbeddedImages: string[] = [];
    
    // Collect all embedded images from all pages
    for (const page of pdfData) {
      if (page.embeddedImages && page.embeddedImages.length > 0) {
        allEmbeddedImages.push(...page.embeddedImages);
      }
    }
    
    this.logger.debug(`Found ${allEmbeddedImages.length} total embedded images across all pages`);
    
    // Use embedded images for various image fields if available
    if (allEmbeddedImages.length > 0) {
      // Use first embedded image for new_section_image
      consolidated.new_section_image = allEmbeddedImages[0];
      this.logger.debug(`Using embedded image for new_section_image: ${allEmbeddedImages[0]}`);
      
      // If there are more, use them for other image fields
      if (allEmbeddedImages.length > 1) {
        consolidated.footer_logo = allEmbeddedImages[1];
        this.logger.debug(`Using embedded image for footer_logo: ${allEmbeddedImages[1]}`);
      }
      
      // If there are even more, use them for client logos
      for (let i = 0; i < Math.min(allEmbeddedImages.length - 2, 5); i++) {
        if (i + 2 < allEmbeddedImages.length) {
          consolidated[`client_logo_${i+1}`] = allEmbeddedImages[i+2];
          this.logger.debug(`Using embedded image for client_logo_${i+1}: ${allEmbeddedImages[i+2]}`);
        }
      }
    }

    // Use first page for main content
    if (pdfData[0]) {
      // Main title and description from Mistral analysis
      consolidated.title_text = pdfData[0].title || '';
      consolidated.paragraph_text = pdfData[0].description || '';
      
      // If we have logos, use the first as site logo
      if (pdfData[0].logos && pdfData[0].logos.length > 0) {
        consolidated.site_logo = pdfData[0].logos[0];
        
        // If we have multiple logos, use the second for client company
        if (pdfData[0].logos.length > 1) {
          consolidated.client_company_logo = pdfData[0].logos[1];
        }
        
        // Use additional logos for client logos if available
        for (let i = 0; i < Math.min(pdfData[0].logos.length - 2, 5); i++) {
          consolidated[`client_logo_${i+1}`] = pdfData[0].logos[i+2];
        }
      }
      
      // Fall back to detected photos if no embedded images found
      if (pdfData[0].photos && pdfData[0].photos.length > 0) {
        consolidated.new_section_image = pdfData[0].photos[0];
        this.logger.debug(`Using photo from first page for new_section_image: ${pdfData[0].photos[0]}`);
      }
    }

    // Look for "about us" section in subsequent pages
    if (pdfData.length > 1) {
      // Use second page info for about us section if available
      consolidated.about_us_title = pdfData[1]?.title || 'About Us';
      consolidated.about_us_paragraph = pdfData[1]?.description || '';
      
      // Use a scene image if available
      if (pdfData[1]?.scenes && pdfData[1].scenes.length > 0) {
        consolidated.new_section_image = consolidated.new_section_image || pdfData[1].scenes[0];
      }
    }

    // For section title/paragraph, use content from later pages if available
    if (pdfData.length > 2) {
      consolidated.new_section_title = pdfData[2]?.title || 'Our Services';
      consolidated.new_section_paragraph = pdfData[2]?.description || '';
    }

    // Use the last logo as footer logo if available
    const allLogos = pdfData.flatMap(page => page.logos || []);
    if (allLogos.length > 0) {
      consolidated.footer_logo = allLogos[allLogos.length - 1];
    }

    return consolidated;
  }

  /**
   * Maps consolidated PDF data to a specific template
   */
  private mapToTemplate(template: WordPressTemplate, data: Record<string, any>): TemplateMapping {
    const mappedFields: Record<string, string> = {};
    const missingRequiredFields: string[] = [];
    let matchCount = 0;
    let requiredFieldsCount = 0;
    
    for (const field of template.fields) {
      // Check if we have data for this field
      if (data[field.name] && data[field.name] !== '') {
        mappedFields[field.name] = data[field.name];
        matchCount++;
      } else if (field.required) {
        missingRequiredFields.push(field.name);
      }
      
      if (field.required) {
        requiredFieldsCount++;
      }
    }
    
    // Calculate match percentage (weighted more heavily toward required fields)
    const requiredWeight = 0.7;
    const optionalWeight = 0.3;
    
    const requiredFieldsFound = requiredFieldsCount - missingRequiredFields.length;
    const optionalFieldsFound = matchCount - requiredFieldsFound;
    const optionalFieldsTotal = template.fields.length - requiredFieldsCount;
    
    let matchPercentage = 0;
    if (requiredFieldsCount > 0) {
      matchPercentage += (requiredFieldsFound / requiredFieldsCount) * requiredWeight * 100;
    } else {
      matchPercentage += requiredWeight * 100; // All required fields matched (none required)
    }
    
    if (optionalFieldsTotal > 0) {
      matchPercentage += (optionalFieldsFound / optionalFieldsTotal) * optionalWeight * 100;
    }
    
    return {
      templateName: template.name,
      mappedFields,
      matchPercentage,
      missingRequiredFields
    };
  }

  /**
   * Uploads a local image to the WordPress media library
   * @param imagePath Local path to the image file
   * @returns WordPress media URL for the uploaded image
   */
  private async uploadImageToWordPress(imagePath: string): Promise<string> {
    try {
      if (!imagePath || !imagePath.startsWith('/files/')) {
        this.logger.warn(`Invalid image path: ${imagePath}`);
        return '';
      }

      // Convert /files/hash/path.jpg to actual filesystem path
      const path = require('path');
      const projectRoot = process.cwd();
      const filesDir = 'uploads'; // Changed from 'output' to 'uploads'
      
      // First normalize the input path - replace all forward slashes
      const relativePath = imagePath.replace('/files/', '').replace(/\//g, path.sep);
      
      // Then build the full path using proper path joining
      const fullPath = path.join(projectRoot, filesDir, relativePath);
      
      this.logger.debug(`Original image path: ${imagePath}`);
      this.logger.debug(`Normalized relative path: ${relativePath}`);
      
      this.logger.debug(`Uploading image from: ${fullPath}`);
      
      // Check if file exists
      const fs = require('fs');
      if (!fs.existsSync(fullPath)) {
        this.logger.warn(`Image file not found: ${fullPath}`);
        return '';
      }
      
      // Get file name and mime type
      const fileName = path.basename(fullPath);
      const fileExtension = path.extname(fileName).toLowerCase();
      let mimeType = 'image/jpeg'; // default
      
      // Set mime type based on extension
      if (fileExtension === '.png') mimeType = 'image/png';
      if (fileExtension === '.gif') mimeType = 'image/gif';
      if (fileExtension === '.svg') mimeType = 'image/svg+xml';
      
      // Basic authentication for WordPress
      const auth = Buffer.from(`${this.wpUsername}:${this.wpPassword}`).toString('base64');
      
      // Read the file data as binary
      const fileData = fs.readFileSync(fullPath);
      
      // Upload to WordPress media library using binary data approach
      const response = await fetch(`${this.wpBaseUrl}/media`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Content-Type': mimeType
        },
        body: fileData
      });
      
      if (!response.ok) {
        let errorMessage = `Status: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          errorMessage += ` - ${JSON.stringify(errorData)}`;
        } catch (e) {
          // If can't parse JSON, use text
          const errorText = await response.text();
          errorMessage += ` - ${errorText.substring(0, 200)}`; // Limit size of error text
        }
        
        this.logger.error(`WordPress media upload error: ${errorMessage}`);
        return '';
      }
      
      const mediaData = await response.json() as { source_url: string, id: number };
      this.logger.debug(`Image uploaded successfully: ${mediaData.source_url} (ID: ${mediaData.id})`);
      
      return mediaData.source_url;
    } catch (error) {
      this.logger.error(`Error uploading image to WordPress: ${error.message}`);
      return '';
    }
  }

  /**
   * Process all image fields in acfFields and upload them to WordPress
   * @param acfFields Original field values with local image paths
   * @returns Updated field values with WordPress media URLs
   */
  private async processAndUploadImages(acfFields: Record<string, string>): Promise<Record<string, string>> {
    const imageFieldNames = [
      'site_logo', 
      'client_company_logo', 
      'new_section_image',
      'footer_logo',
      'client_logo_1',
      'client_logo_2',
      'client_logo_3',
      'client_logo_4',
      'client_logo_5'
    ];
    
    const processedFields = { ...acfFields };
    
    // Process each image field
    for (const fieldName of imageFieldNames) {
      if (processedFields[fieldName] && processedFields[fieldName].startsWith('/files/')) {
        this.logger.debug(`Processing image field: ${fieldName}`);
        
        // Upload image to WordPress and get the media URL
        const mediaUrl = await this.uploadImageToWordPress(processedFields[fieldName]);
        
        if (mediaUrl) {
          processedFields[fieldName] = mediaUrl;
          this.logger.debug(`Replaced ${fieldName} with WordPress media URL: ${mediaUrl}`);
        } else {
          // If upload failed, remove the field to avoid broken images
          delete processedFields[fieldName];
          this.logger.warn(`Removed ${fieldName} due to failed upload`);
        }
      }
    }
    
    return processedFields;
  }

  /**
   * Posts content to WordPress using the specified template
   */
  async postToWordPress(
    title: string,
    content: string,
    acfFields: Record<string, string>,
    templateName: string
  ): Promise<any> {
    try {
      // First upload all images to WordPress media library
      this.logger.log('Processing and uploading images to WordPress media library...');
      const processedAcfFields = await this.processAndUploadImages(acfFields);
      
      // Basic authentication for WordPress
      const auth = Buffer.from(`${this.wpUsername}:${this.wpPassword}`).toString('base64');
      
      // Prepare the request body
      const postData = {
        title,
        content,
        status: 'publish',
        acf: {
          ...processedAcfFields,
          _custom_portfolio_template: templateName
        }
      };
      
      this.logger.log('Posting content to WordPress...');
      
      // Make the API request
      const response = await fetch(`${this.wpBaseUrl}/portfolio`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${auth}`
        },
        body: JSON.stringify(postData)
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        this.logger.error(`WordPress API error: ${JSON.stringify(errorData)}`);
        throw new HttpException(
          `Failed to post to WordPress: ${response.statusText}`,
          HttpStatus.BAD_GATEWAY
        );
      }
      
      const result = await response.json() as { id: string; link: string };
      this.logger.log(`Successfully posted to WordPress with ID: ${result.id}`);
      return result;
    } catch (error) {
      this.logger.error(`Error posting to WordPress: ${error.message}`);
      throw new HttpException(
        `Failed to post to WordPress: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}
