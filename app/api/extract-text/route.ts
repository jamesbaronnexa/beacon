// app/api/extract-text/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import pdfParse from 'pdf-parse-new'
import OpenAI from 'openai'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

export async function POST(request: Request) {
  try {
    const { fileName, originalName } = await request.json()
    
    console.log('Processing PDF:', originalName)
    
    // Step 1: Download PDF from storage
    const { data: pdfBlob, error: downloadError } = await supabase.storage
      .from('pdfs')
      .download(fileName)
    
    if (downloadError) throw downloadError
    
    // Step 2: Parse PDF (ignoring font warning - it's non-critical)
    const buffer = Buffer.from(await pdfBlob.arrayBuffer())
    const pdfData = await pdfParse(buffer, {
      pagerender: function(pageData: any) {
        return pageData.getTextContent()
          .then(function(textContent: any) {
            let text = '';
            for (let item of textContent.items) {
              text += item.str + ' ';
            }
            return text + '\n\f';
          });
      }
    })
    
    // Step 3: Split into pages
    const pages = pdfData.text.split('\f').filter(p => p.trim())
    console.log(`PDF has ${pages.length} pages`)
    
    // Step 4: Analyze document structure
    const structureAnalysis = await analyzeDocumentStructure(pages)
    console.log('Structure analysis:', structureAnalysis)
    
    // Step 5: Create document record
    const { data: document, error: docError } = await supabase
      .from('documents')
      .insert({
        title: originalName.replace('.pdf', ''),
        filename: originalName,
        content_starts_at_page: structureAnalysis.content_starts,
        toc_ends_at_page: structureAnalysis.toc_ends
      })
      .select()
      .single()
    
    if (docError) throw docError
    
    // Step 6: Process pages in batches to avoid rate limits
    const batchSize = 5
    const processedPages = []
    
    for (let i = 0; i < pages.length; i += batchSize) {
      const batch = pages.slice(i, i + batchSize)
      const batchPromises = batch.map(async (pageText, batchIndex) => {
        const pageNum = i + batchIndex + 1
        const isContent = pageNum >= structureAnalysis.content_starts
        
        // Generate embedding
        const embedding = await generateEmbedding(pageText)
        
        // Determine page type
        const pageType = getPageType(pageNum, structureAnalysis, pageText)
        
        // Extract section info
        let sectionInfo = { title: null, number: null }
        if (isContent) {
          sectionInfo = extractSectionInfo(pageText)
        }
        
        return {
          document_id: document.id,
          pdf_page_number: pageNum,
          content: pageText,
          embedding,
          is_content: isContent,
          page_type: pageType,
          section_title: sectionInfo.title,
          section_number: sectionInfo.number,
          key_topics: [] // Skip topic extraction for now to speed up
        }
      })
      
      const batchResults = await Promise.all(batchPromises)
      processedPages.push(...batchResults)
      
      console.log(`Processed pages ${i + 1} to ${Math.min(i + batchSize, pages.length)}`)
    }
    
    // Step 7: Insert all pages
    const { error: pagesError } = await supabase
      .from('pages')
      .insert(processedPages)
    
    if (pagesError) throw pagesError
    
    // Step 8: Extract and store sections
    const sections = extractSections(processedPages)
    if (sections.length > 0) {
      const { error: sectionsError } = await supabase
        .from('sections')
        .insert(sections.map(s => ({
          ...s,
          document_id: document.id
        })))
      
      if (sectionsError) console.error('Sections insert error:', sectionsError)
    }
    
    return NextResponse.json({
      success: true,
      documentId: document.id,
      totalPages: pages.length,
      contentStartsAt: structureAnalysis.content_starts,
      sectionsFound: sections.length
    })
    
  } catch (error) {
    console.error('PDF processing error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Processing failed' },
      { status: 500 }
    )
  }
}

// Simplified structure analysis
async function analyzeDocumentStructure(pages: string[]) {
  const firstPages = pages.slice(0, Math.min(15, pages.length))
  
  const prompt = `Find where the main content starts in this technical PDF.
Look for "Section 1", "1 Scope", "1. Introduction", etc.

${firstPages.map((page, i) => {
  const lines = page.split('\n').filter(l => l.trim()).slice(0, 5)
  return `Page ${i + 1}: ${lines.join(' | ').substring(0, 200)}`
}).join('\n')}

Return JSON: {"content_starts": <page number>, "toc_ends": <page number or 0>}`

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo', // Use 3.5 for cost savings
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0
    })
    
    const result = JSON.parse(response.choices[0].message.content!)
    return {
      content_starts: result.content_starts || 1,
      toc_ends: result.toc_ends || 0
    }
  } catch (error) {
    console.error('Structure analysis failed:', error)
    return { content_starts: 1, toc_ends: 0 }
  }
}

// Other helper functions remain the same...
function getPageType(pageNum: number, structure: any, pageText: string): string {
  const lowerText = pageText.toLowerCase()
  
  if (pageNum < structure.content_starts) {
    if (lowerText.includes('table of contents') || lowerText.includes('contents\n')) {
      return 'toc'
    }
    if (lowerText.includes('preface') || lowerText.includes('foreword')) {
      return 'preface'
    }
    if (pageNum <= 2) {
      return 'cover'
    }
  }
  
  if (lowerText.includes('appendix')) {
    return 'appendix'
  }
  
  return 'content'
}

function extractSectionInfo(pageText: string): { title: string | null, number: string | null } {
  const lines = pageText.split('\n').filter(l => l.trim())
  const sectionPattern = /^(?:Section\s+)?(\d+(?:\.\d+)*)\s+(.+)/
  
  for (const line of lines.slice(0, 5)) {
    const match = line.match(sectionPattern)
    if (match) {
      return {
        number: match[1],
        title: match[2].trim()
      }
    }
  }
  
  return { title: null, number: null }
}

function extractSections(pages: any[]): any[] {
  const sections: Map<string, any> = new Map()
  
  pages.forEach(page => {
    if (page.section_number && page.section_title) {
      if (!sections.has(page.section_number)) {
        sections.set(page.section_number, {
          section_number: page.section_number,
          title: page.section_title,
          start_page: page.pdf_page_number,
          end_page: page.pdf_page_number,
          parent_section_number: page.section_number.includes('.') 
            ? page.section_number.split('.').slice(0, -1).join('.') 
            : null
        })
      } else {
        sections.get(page.section_number)!.end_page = page.pdf_page_number
      }
    }
  })
  
  return Array.from(sections.values())
}

async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000)
    })
    
    return response.data[0].embedding
  } catch (error) {
    console.error('Embedding generation failed:', error)
    return new Array(1536).fill(0)
  }
}