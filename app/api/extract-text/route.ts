import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import pdfParse from 'pdf-parse-new'

// Create Supabase client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

export async function POST(request) {
  try {
    const { fileName, originalName } = await request.json()
    
    console.log('Extracting text from:', fileName)
    
    // Get the PDF from Supabase storage
    const { data, error } = await supabase.storage
      .from('pdfs')
      .download(fileName)
    
    if (error) {
      console.error('Supabase download error:', error)
      throw error
    }
    
    // Convert blob to buffer
    const buffer = Buffer.from(await data.arrayBuffer())
    
    // Parse PDF with pdf-parse-new
    const pdfData = await pdfParse(buffer, {
      // Return page breaks for better parsing
      pagerender: function(pageData) {
        return pageData.getTextContent()
          .then(function(textContent) {
            let text = '';
            for (let item of textContent.items) {
              text += item.str + ' ';
            }
            return text + '\n\f'; // Add form feed for page break
          });
      }
    })
    
    console.log('PDF info:', {
      pages: pdfData.numpages,
      textLength: pdfData.text.length
    })
    
    // Split by page breaks or estimate pages
    let pageTexts = []
    
    // Check if we have page breaks (form feed characters)
    if (pdfData.text.includes('\f')) {
      const pages = pdfData.text.split('\f')
      pageTexts = pages
        .filter(page => page.trim())
        .map((pageText, index) => {
          const text = pageText.trim()
          const lowerText = text.toLowerCase()
          
          // Detect TOC and title pages
          const isTOC = (
            lowerText.includes('table of contents') ||
            lowerText.includes('contents\n') ||
            (lowerText.includes('index') && index < 5)
          )
          
          const isTitle = (
            index === 0 && text.length < 200
          )
          
          return {
            pageNumber: index + 1,
            text: text,
            isTOC: isTOC,
            isTitle: isTitle,
            charCount: text.length
          }
        })
    } else {
      // No page breaks detected - use original simple splitting
      console.log('No page breaks found, dividing evenly')
      const avgCharsPerPage = Math.ceil(pdfData.text.length / pdfData.numpages)
      
      for (let i = 0; i < pdfData.numpages; i++) {
        const start = i * avgCharsPerPage
        const end = Math.min((i + 1) * avgCharsPerPage, pdfData.text.length)
        const text = pdfData.text.substring(start, end).trim()
        
        pageTexts.push({
          pageNumber: i + 1,
          text: text,
          isTOC: false,
          isTitle: false,
          charCount: text.length
        })
      }
    }
    
    // Detect where content starts
    let contentStartsAt = 1
    for (const page of pageTexts) {
      if (!page.isTOC && !page.isTitle && page.charCount > 500) {
        contentStartsAt = page.pageNumber
        break
      }
    }
    
    console.log(`Extracted ${pageTexts.length} pages, content starts at page ${contentStartsAt}`)
    
    // Save PDF record to database
    const { data: pdfRecord, error: pdfError } = await supabase
      .from('pdfs')
      .insert({
        file_name: fileName,
        original_name: originalName,
        storage_path: `pdfs/${fileName}`,
        total_pages: pdfData.numpages,
        total_characters: pdfData.text.length,
        user_id: 'test-user', // We'll add real auth later
        has_toc: pageTexts.some(p => p.isTOC),
        content_starts_at: contentStartsAt
      })
      .select()
      .single()
    
    if (pdfError) {
      console.error('Database error:', pdfError)
      throw pdfError
    }
    
    // Save each page to database
    const pageRecords = pageTexts.map(page => ({
      pdf_id: pdfRecord.id,
      page_number: page.pageNumber,
      text_content: page.text,
      is_toc: page.isTOC || false,
      is_title: page.isTitle || false,
      char_count: page.charCount
    }))
    
    const { error: pagesError } = await supabase
      .from('pdf_pages')
      .insert(pageRecords)
    
    if (pagesError) {
      console.error('Pages insert error:', pagesError)
      throw pagesError
    }
    
    console.log(`Saved PDF ${pdfRecord.id} with ${pageTexts.length} pages`)
    
    // Create full text with page markers for display
    let fullText = ''
    pageTexts.forEach(page => {
      fullText += `\n--- Page ${page.pageNumber} ---\n${page.text}\n`
    })
    
    return NextResponse.json({
      success: true,
      pdfId: pdfRecord.id,
      fileName: fileName,
      pages: pdfData.numpages,
      fullText: fullText,
      pageTexts: pageTexts,
      totalCharacters: pdfData.text.length,
      avgCharsPerPage: Math.round(pdfData.text.length / pdfData.numpages),
      metadata: {
        hasTOC: pageTexts.some(p => p.isTOC),
        contentStartsAt: contentStartsAt,
        info: pdfData.info
      }
    })
    
  } catch (error) {
    console.error('Error extracting text:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}