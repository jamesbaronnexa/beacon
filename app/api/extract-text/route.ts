import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import pdfParse from 'pdf-parse-new'
import OpenAI from 'openai'

// Create Supabase client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

// Create OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

// AI-powered document structure analysis
async function analyzeDocumentStructure(pages, fileName) {
  try {
    // Take first 20 pages for analysis (covers most front matter)
    const sampleSize = Math.min(20, pages.length)
    const samplePages = pages.slice(0, sampleSize).map((text, i) => {
      // Get first 300 chars and last 100 chars (where page numbers often are)
      const preview = text.substring(0, 300).replace(/\s+/g, ' ').trim()
      const footer = text.substring(Math.max(0, text.length - 100)).replace(/\s+/g, ' ').trim()
      return {
        page: i + 1,
        preview: preview,
        footer: footer,
        length: text.length
      }
    })

    const prompt = `Analyze this technical/trade manual PDF structure. Identify each page type and find where the actual content begins.

${samplePages.map(p => 
  `Page ${p.page} (${p.length} chars):
Start: "${p.preview}"
End: "${p.footer}"
---`
).join('\n')}

For each page, determine:
1. Page type (title, toc, preface, glossary, main, appendix, blank)
2. Any visible page number (look for "Page X", just "X" at bottom/top, roman numerals like "iv")
3. Where the MAIN CONTENT actually starts (usually where you see "Page 1" or "Chapter 1" or technical content begins)

Return JSON:
{
  "pages": [
    {
      "physicalPage": 1,
      "type": "title|toc|preface|glossary|main|appendix|blank",
      "visiblePageNumber": null or "1" or "iv" etc,
      "confidence": 0-100
    }
  ],
  "mainContentStart": {
    "physicalPage": 7,
    "reason": "First page marked as '1' / Main technical content begins"
  },
  "documentType": "manual|code|standard|specification"
}`

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 800
    })

    const analysis = JSON.parse(response.choices[0].message.content)
    console.log('AI Analysis complete:', analysis.mainContentStart)
    return analysis

  } catch (error) {
    console.error('AI analysis failed:', error)
    // Return null to fallback to basic detection
    return null
  }
}

// Fallback basic detection if AI fails
function basicPageTypeDetection(pageText, pageNumber) {
  const lowerText = pageText.toLowerCase()
  
  if (pageText.trim().length < 100) {
    return { type: 'blank', confidence: 90 }
  }
  
  if (pageNumber <= 3 && pageText.length < 1000) {
    if (lowerText.includes('copyright') || lowerText.includes('published')) {
      return { type: 'title', confidence: 70 }
    }
  }
  
  if (lowerText.includes('table of contents') || lowerText.includes('contents\n')) {
    return { type: 'toc', confidence: 80 }
  }
  
  if (lowerText.includes('preface') || lowerText.includes('introduction') || lowerText.includes('foreword')) {
    return { type: 'preface', confidence: 70 }
  }
  
  if (lowerText.includes('glossary') || lowerText.includes('definitions')) {
    return { type: 'glossary', confidence: 70 }
  }
  
  if (lowerText.includes('appendix') || lowerText.includes('annex')) {
    return { type: 'appendix', confidence: 70 }
  }
  
  // Default to main if has substantial text
  if (pageText.length > 500) {
    return { type: 'main', confidence: 50 }
  }
  
  return { type: 'unknown', confidence: 0 }
}

export async function POST(request) {
  try {
    const { fileName, originalName, useAI = true } = await request.json()
    
    console.log('=== Starting PDF extraction ===')
    console.log('File:', originalName)
    console.log('AI Analysis:', useAI ? 'Enabled' : 'Disabled')
    
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
    
    // Parse PDF with page breaks
    const pdfData = await pdfParse(buffer, {
      pagerender: function(pageData) {
        return pageData.getTextContent()
          .then(function(textContent) {
            let text = '';
            for (let item of textContent.items) {
              text += item.str + ' ';
            }
            return text + '\n\f'; // Form feed for page break
          });
      }
    })
    
    console.log('PDF parsed:', {
      pages: pdfData.numpages,
      textLength: pdfData.text.length
    })
    
    // Split into pages
    const pages = pdfData.text.split('\f').filter(p => p.trim())
    
    let aiAnalysis = null
    let pageTexts = []
    let contentStartsAt = 1
    
    // Try AI analysis first if enabled
    if (useAI && process.env.OPENAI_API_KEY) {
      console.log('Running AI analysis...')
      aiAnalysis = await analyzeDocumentStructure(pages, originalName)
    }
    
    // Build page data with AI insights or fallback
    if (aiAnalysis && aiAnalysis.pages) {
      // Use AI analysis
      pageTexts = pages.map((text, i) => {
        const pageNum = i + 1
        const aiPage = aiAnalysis.pages.find(p => p.physicalPage === pageNum) || {}
        
        // Parse actual page number
        let actualPageNumber = null
        if (aiPage.visiblePageNumber) {
          // Check if it's a roman numeral
          if (/^[ivxlcdm]+$/i.test(aiPage.visiblePageNumber)) {
            actualPageNumber = -romanToArabic(aiPage.visiblePageNumber) // Store as negative for roman
          } else {
            actualPageNumber = parseInt(aiPage.visiblePageNumber)
          }
        }
        
        return {
          pageNumber: pageNum,
          text: text.trim(),
          type: aiPage.type || 'unknown',
          isMainContent: aiPage.type === 'main',
          isTOC: aiPage.type === 'toc',
          isTitle: aiPage.type === 'title',
          isPreface: aiPage.type === 'preface',
          isGlossary: aiPage.type === 'glossary',
          isAppendix: aiPage.type === 'appendix',
          charCount: text.length,
          actualPageNumber: actualPageNumber,
          confidence: aiPage.confidence || 0
        }
      })
      
      contentStartsAt = aiAnalysis.mainContentStart?.physicalPage || 1
      console.log(`AI determined content starts at page ${contentStartsAt}: ${aiAnalysis.mainContentStart?.reason}`)
      
    } else {
      // Fallback to basic detection
      console.log('Using basic detection (AI unavailable)')
      
      pageTexts = pages.map((text, i) => {
        const pageNum = i + 1
        const detection = basicPageTypeDetection(text, pageNum)
        
        return {
          pageNumber: pageNum,
          text: text.trim(),
          type: detection.type,
          isMainContent: detection.type === 'main',
          isTOC: detection.type === 'toc',
          isTitle: detection.type === 'title',
          isPreface: detection.type === 'preface',
          isGlossary: detection.type === 'glossary',
          isAppendix: detection.type === 'appendix',
          charCount: text.length,
          actualPageNumber: null,
          confidence: detection.confidence
        }
      })
      
      // Simple logic: find first main content page
      const firstMain = pageTexts.find(p => p.isMainContent)
      if (firstMain) {
        contentStartsAt = firstMain.pageNumber
      }
    }
    
    // Extract TOC if found
    let tocEntries = null
    const tocPages = pageTexts.filter(p => p.isTOC)
    if (tocPages.length > 0) {
      tocEntries = extractTOCEntries(tocPages.map(p => p.text).join('\n'))
    }
    
    // Log summary
    console.log('\n=== Extraction Summary ===')
    console.log(`Total pages: ${pageTexts.length}`)
    console.log(`Main content starts: page ${contentStartsAt}`)
    console.log(`Title pages: ${pageTexts.filter(p => p.isTitle).map(p => p.pageNumber).join(', ') || 'none'}`)
    console.log(`TOC pages: ${pageTexts.filter(p => p.isTOC).map(p => p.pageNumber).join(', ') || 'none'}`)
    console.log(`TOC entries found: ${tocEntries ? tocEntries.length : 0}`)
    
    // Save to database
    const { data: pdfRecord, error: pdfError } = await supabase
      .from('pdfs')
      .insert({
        file_name: fileName,
        original_name: originalName,
        storage_path: `pdfs/${fileName}`,
        total_pages: pdfData.numpages,
        total_characters: pdfData.text.length,
        user_id: 'test-user',
        has_toc: pageTexts.some(p => p.isTOC),
        content_starts_at: contentStartsAt,
        metadata: {
          aiAnalysis: aiAnalysis,
          tocEntries: tocEntries,
          pageTypes: pageTexts.map(p => ({
            page: p.pageNumber,
            type: p.type,
            confidence: p.confidence
          })),
          extractedAt: new Date().toISOString()
        }
      })
      .select()
      .single()
    
    if (pdfError) {
      console.error('Database error:', pdfError)
      throw pdfError
    }
    
    // Save pages
    const pageRecords = pageTexts.map(page => ({
      pdf_id: pdfRecord.id,
      page_number: page.pageNumber,
      text_content: page.text,
      is_toc: page.isTOC || false,
      is_title: page.isTitle || false,
      is_main_content: page.isMainContent || false,
      page_type: page.type,
      char_count: page.charCount,
      actual_page_number: page.actualPageNumber
    }))
    
    const { error: pagesError } = await supabase
      .from('pdf_pages')
      .insert(pageRecords)
    
    if (pagesError) {
      console.error('Pages insert error:', pagesError)
      throw pagesError
    }
    
    console.log(`✅ Saved PDF ${pdfRecord.id} with ${pageTexts.length} pages`)
    
    // Return success with summary
    return NextResponse.json({
      success: true,
      pdfId: pdfRecord.id,
      fileName: fileName,
      pages: pdfData.numpages,
      totalCharacters: pdfData.text.length,
      metadata: {
        contentStartsAt: contentStartsAt,
        hasTOC: pageTexts.some(p => p.isTOC),
        tocEntries: tocEntries ? tocEntries.length : 0,
        aiAnalyzed: !!aiAnalysis,
        pageTypeSummary: {
          title: pageTexts.filter(p => p.isTitle).length,
          toc: pageTexts.filter(p => p.isTOC).length,
          preface: pageTexts.filter(p => p.isPreface).length,
          main: pageTexts.filter(p => p.isMainContent).length,
          appendix: pageTexts.filter(p => p.isAppendix).length
        }
      }
    })
    
  } catch (error) {
    console.error('Extraction error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// Helper function to extract TOC entries
function extractTOCEntries(tocText) {
  const entries = []
  const lines = tocText.split('\n')
  
  for (const line of lines) {
    // Skip empty lines
    if (!line.trim() || line.length < 3) continue
    
    // Look for patterns like "1.1 Title ... 23"
    const patterns = [
      /^([\d.]+)\s+(.+?)[\s.]*(\d{1,3})$/,
      /^(.+?)\.{2,}\s*(\d{1,3})$/,
      /^(.+?)\s+(\d{1,3})$/
    ]
    
    for (const pattern of patterns) {
      const match = line.trim().match(pattern)
      if (match) {
        const hasSection = match.length === 4
        entries.push({
          section: hasSection ? match[1].trim() : null,
          title: hasSection ? match[2].trim() : match[1].trim(),
          page: parseInt(hasSection ? match[3] : match[2])
        })
        break
      }
    }
  }
  
  return entries.filter(e => e.page > 0 && e.page < 500)
}

// Helper to convert roman to arabic
function romanToArabic(roman) {
  const values = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }
  let result = 0
  let prev = 0
  
  for (let i = roman.length - 1; i >= 0; i--) {
    const current = values[roman[i].toLowerCase()]
    if (current < prev) {
      result -= current
    } else {
      result += current
    }
    prev = current
  }
  
  return result
}