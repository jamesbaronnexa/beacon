import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import pdfParse from 'pdf-parse-new'

// Create Supabase client
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

// Patterns to identify different section types
const SECTION_PATTERNS = {
  title: {
    patterns: [
      /^[A-Z][A-Z\s]+$/m, // ALL CAPS TITLE
      /manual|guide|handbook|specification|standard|code/i,
      /edition|version|revision/i,
      /copyright|©|\d{4}/i, // Copyright year
      /issued|published|effective/i
    ],
    maxPages: 3,
    maxChars: 800
  },
  toc: {
    patterns: [
      /table of contents/i,
      /^contents$/mi,
      /^index$/mi,
      /page \d+/gi, // Multiple "page X" references
      /\.\.\.\.\s*\d+/g, // Dotted leaders to page numbers
      /chapter \d+/gi,
      /section \d+/gi,
      /appendix [a-z]/gi,
      /part [ivx]+/gi // Roman numerals for parts
    ],
    indicators: {
      minPageRefs: 5, // At least 5 page number references
      hasStructure: true // Look for consistent formatting
    }
  },
  preface: {
    patterns: [
      /^preface$/mi,
      /^foreword$/mi,
      /^introduction$/mi,
      /^acknowledgment/mi,
      /^about this (manual|guide|document|code|standard)/i,
      /purpose of this/i,
      /how to use this/i,
      /^scope$/mi,
      /^overview$/mi
    ]
  },
  mainContent: {
    patterns: [
      /^(chapter |section )?(\d+|one|two|three|four|five)/i,
      /^1\./m, // Numbered sections starting with 1.
      /general requirements/i,
      /specifications/i,
      /installation/i,
      /operation/i,
      /maintenance/i,
      /safety/i,
      /electrical/i,
      /wiring/i
    ]
  }
}

function extractPageNumber(pageText) {
  // First check for Roman numerals (common in front matter)
  const romanPatterns = [
    /\n[\s]*([ivxlcdm]+)[\s]*$/mi, // Roman at bottom
    /^[\s]*([ivxlcdm]+)[\s]*\n/mi, // Roman at top
    /\n[\s]*[-–—]\s*([ivxlcdm]+)\s*[-–—][\s]*$/mi, // - iv -
    /(?:Page|Pg\.?|P\.?)\s*([ivxlcdm]+)/i, // Page iv
  ]
  
  // Convert Roman to Arabic
  function romanToArabic(roman) {
    const romanNumerals = {
      'i': 1, 'v': 5, 'x': 10, 'l': 50,
      'c': 100, 'd': 500, 'm': 1000
    }
    
    let result = 0
    let prevValue = 0
    
    for (let i = roman.length - 1; i >= 0; i--) {
      const currentValue = romanNumerals[roman[i].toLowerCase()]
      if (!currentValue) return null
      
      if (currentValue < prevValue) {
        result -= currentValue
      } else {
        result += currentValue
      }
      prevValue = currentValue
    }
    
    return result
  }
  
  // Check for Roman numerals first (usually in front matter)
  for (const pattern of romanPatterns) {
    const match = pageText.match(pattern)
    if (match && match[1]) {
      // Validate it's a reasonable Roman numeral (i-xxx range for front matter)
      const roman = match[1].toLowerCase()
      if (/^[ivx]+$/.test(roman) && roman.length <= 4) { // Max xxix (29) for front matter
        const arabicNum = romanToArabic(roman)
        if (arabicNum && arabicNum <= 30) {
          return { type: 'roman', value: roman, arabic: arabicNum }
        }
      }
    }
  }
  
  // Look for regular page numbers
  const patterns = [
    // Bottom of page patterns
    /\n[\s]*(\d+)[\s]*$/m, // Number at end
    /\n[\s]*[-–—]\s*(\d+)\s*[-–—][\s]*$/m, // - X -
    /\n[\s]*Page\s+(\d+)[\s]*$/mi, // Page X at bottom
    /\n[\s]*\[(\d+)\][\s]*$/m, // [X] at bottom
    /\n[\s]*\((\d+)\)[\s]*$/m, // (X) at bottom
    
    // Top of page patterns
    /^[\s]*(\d+)[\s]*\n/m, // Number at top
    /^[\s]*Page\s+(\d+)[\s]*\n/mi, // Page X at top
    /^[\s]*[-–—]\s*(\d+)\s*[-–—][\s]*\n/m, // - X - at top
    
    // Header/footer patterns
    /(?:Page|Pg\.?|P\.?)\s*(\d+)\s*(?:of|\/)/i, // Page X of/Page X/
    /\d{4}.*?[-–—]\s*(\d+)\s*$/m, // Year/code followed by page number
  ]
  
  for (const pattern of patterns) {
    const match = pageText.match(pattern)
    if (match && match[1]) {
      const pageNum = parseInt(match[1])
      // Sanity check - page numbers should be reasonable
      if (pageNum > 0 && pageNum < 2000) {
        return { type: 'arabic', value: pageNum, arabic: pageNum }
      }
    }
  }
  
  return null
}

function analyzePage(pageText, pageNumber) {
  const analysis = {
    pageNumber,
    type: 'unknown',
    confidence: 0,
    isMainContent: false,
    hasPageNumber: false,
    actualPageNumber: null,
    pageNumberType: null, // 'roman' or 'arabic'
    romanNumeral: null,
    charCount: pageText.length
  }
  
  // Check for empty or nearly empty pages
  if (pageText.trim().length < 50) {
    analysis.type = 'blank'
    return analysis
  }
  
  // Extract page number if present
  const foundPageNumber = extractPageNumber(pageText)
  if (foundPageNumber !== null) {
    analysis.hasPageNumber = true
    if (foundPageNumber.type === 'roman') {
      analysis.pageNumberType = 'roman'
      analysis.romanNumeral = foundPageNumber.value
      analysis.actualPageNumber = -foundPageNumber.arabic // Negative to indicate Roman
    } else {
      analysis.pageNumberType = 'arabic'
      analysis.actualPageNumber = foundPageNumber.arabic
    }
  }
  
  // Score each section type
  const scores = {}
  
  // Check for title page (usually first few pages)
  if (pageNumber <= SECTION_PATTERNS.title.maxPages && 
      pageText.length < SECTION_PATTERNS.title.maxChars) {
    let titleScore = 0
    for (const pattern of SECTION_PATTERNS.title.patterns) {
      if (pattern.test(pageText)) titleScore += 20
    }
    // Boost score if it's the first page and short
    if (pageNumber === 1 && pageText.length < 300) titleScore += 20
    scores.title = titleScore
  }
  
  // Check for TOC
  let tocScore = 0
  const pageRefs = (pageText.match(/\b\d{1,3}\b/g) || []).length
  const hasDottedLeaders = /\.\.\.\.\s*\d+/.test(pageText)
  const hasMultiplePageRefs = (pageText.match(/page\s+\d+/gi) || []).length >= 3
  
  for (const pattern of SECTION_PATTERNS.toc.patterns) {
    if (pattern.test(pageText)) tocScore += 15
  }
  if (pageRefs >= SECTION_PATTERNS.toc.indicators.minPageRefs) tocScore += 25
  if (hasDottedLeaders) tocScore += 20
  if (hasMultiplePageRefs) tocScore += 15
  
  // Look for TOC structure - multiple lines ending with numbers
  const linesEndingWithNumbers = (pageText.match(/[^\d]\d{1,3}[\s]*$/gm) || []).length
  if (linesEndingWithNumbers >= 5) tocScore += 20
  
  scores.toc = tocScore
  
  // Check for preface/intro
  let prefaceScore = 0
  for (const pattern of SECTION_PATTERNS.preface.patterns) {
    if (pattern.test(pageText)) {
      prefaceScore += 35
      // Only count once per page
      break
    }
  }
  // Preface is usually in first 10 pages
  if (pageNumber <= 10 && prefaceScore > 0) prefaceScore += 10
  scores.preface = prefaceScore
  
  // Check for main content
  let mainScore = 0
  for (const pattern of SECTION_PATTERNS.mainContent.patterns) {
    if (pattern.test(pageText)) mainScore += 15
  }
  
  // Substantial text is a good indicator
  if (pageText.length > 1000) mainScore += 20
  else if (pageText.length > 500) mainScore += 10
  
  // Technical terms specific to electrical/trades
  const technicalTerms = /voltage|ampere|amp|circuit|wire|cable|grounding|conductor|breaker|panel|load|phase|neutral|ohm|watt|resistance|current|electrical|switch|outlet|receptacle|conduit|gauge|awg/gi
  const techMatches = (pageText.match(technicalTerms) || []).length
  mainScore += Math.min(techMatches * 2, 30)
  
  // Numbered sections are strong indicators
  if (/^\d+\.\d+/m.test(pageText)) mainScore += 15
  
  scores.main = mainScore
  
  // Determine the type based on highest score
  const maxScore = Math.max(...Object.values(scores))
  if (maxScore >= 30) {
    for (const [type, score] of Object.entries(scores)) {
      if (score === maxScore) {
        analysis.type = type
        analysis.confidence = score
        analysis.isMainContent = type === 'main'
        break
      }
    }
  }
  
  // Default to main content if we're past page 10 and have substantial text
  if (analysis.type === 'unknown' && pageNumber > 10 && pageText.length > 500) {
    analysis.type = 'main'
    analysis.isMainContent = true
    analysis.confidence = 40
  }
  
  return analysis
}

function extractTOC(tocText) {
  const entries = []
  const lines = tocText.split('\n')
  
  for (const line of lines) {
    // Skip empty lines and headers
    if (!line.trim() || line.length < 3) continue
    
    // Match various TOC formats
    const patterns = [
      // "1.1 Title.....23" or "1.1 Title 23"
      /^([\d.]+)\s+(.+?)[\s.]*(\d{1,3})$/,
      // "Chapter 1: Title.....23"
      /^(Chapter\s+\d+:?)\s+(.+?)[\s.]*(\d{1,3})$/i,
      // "Section A - Title.....23"
      /^(Section\s+[A-Z]:?)\s+(.+?)[\s.]*(\d{1,3})$/i,
      // "Title.............23" (no section number)
      /^([^.]+)\.{2,}\s*(\d{1,3})$/,
      // "Title 23" (simple format)
      /^(.+?)\s+(\d{1,3})$/,
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
  
  // Filter out unlikely TOC entries (page numbers too high, etc.)
  return entries.filter(e => e.page > 0 && e.page < 500 && e.title.length > 2)
}

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
      textLength: pdfData.text.length,
      info: pdfData.info
    })
    
    // Split by page breaks or estimate pages
    let pageTexts = []
    let pageAnalyses = []
    
    // Check if we have page breaks (form feed characters)
    if (pdfData.text.includes('\f')) {
      const pages = pdfData.text.split('\f').filter(p => p.trim())
      
      // First pass: analyze all pages
      pageAnalyses = pages.map((pageText, index) => {
        return analyzePage(pageText.trim(), index + 1)
      })
      
      // Build page texts with analysis
      pageTexts = pages.map((pageText, index) => {
        const analysis = pageAnalyses[index]
        return {
          pageNumber: index + 1,
          text: pageText.trim(),
          type: analysis.type,
          isMainContent: analysis.isMainContent,
          isTOC: analysis.type === 'toc',
          isTitle: analysis.type === 'title',
          isPreface: analysis.type === 'preface',
          charCount: analysis.charCount,
          hasPageNumber: analysis.hasPageNumber,
          actualPageNumber: analysis.actualPageNumber,
          pageNumberType: analysis.pageNumberType,
          romanNumeral: analysis.romanNumeral,
          confidence: analysis.confidence
        }
      })
    } else {
      // No page breaks detected - use simple splitting
      console.log('No page breaks found, dividing evenly')
      const avgCharsPerPage = Math.ceil(pdfData.text.length / pdfData.numpages)
      
      for (let i = 0; i < pdfData.numpages; i++) {
        const start = i * avgCharsPerPage
        const end = Math.min((i + 1) * avgCharsPerPage, pdfData.text.length)
        const text = pdfData.text.substring(start, end).trim()
        
        const analysis = analyzePage(text, i + 1)
        
        pageTexts.push({
          pageNumber: i + 1,
          text: text,
          type: analysis.type,
          isMainContent: analysis.isMainContent,
          isTOC: analysis.type === 'toc',
          isTitle: analysis.type === 'title',
          isPreface: analysis.type === 'preface',
          charCount: text.length,
          hasPageNumber: analysis.hasPageNumber,
          actualPageNumber: analysis.actualPageNumber,
          pageNumberType: analysis.pageNumberType,
          romanNumeral: analysis.romanNumeral,
          confidence: analysis.confidence
        })
      }
    }
    
    // Find where main content starts
    let contentStartsAt = 1
    
    // Method 1: Look for first page marked as Arabic "1"
    const pageOne = pageTexts.find(p => 
      p.actualPageNumber === 1 && p.pageNumberType === 'arabic'
    )
    if (pageOne) {
      contentStartsAt = pageOne.pageNumber
      console.log(`Found Arabic page "1" at physical page ${contentStartsAt}`)
    } else {
      // Method 2: Find where Roman numerals end and Arabic begins
      let lastRoman = -1
      let firstArabic = -1
      
      for (let i = 0; i < pageTexts.length; i++) {
        if (pageTexts[i].pageNumberType === 'roman') {
          lastRoman = i
        } else if (pageTexts[i].pageNumberType === 'arabic' && firstArabic === -1) {
          firstArabic = i
        }
      }
      
      if (lastRoman >= 0 && firstArabic > lastRoman) {
        contentStartsAt = pageTexts[firstArabic].pageNumber
        console.log(`Content starts after Roman numerals at physical page ${contentStartsAt}`)
      } else {
        // Method 3: Find first main content page
        const firstMainPage = pageTexts.find(p => p.isMainContent)
        if (firstMainPage) {
          contentStartsAt = firstMainPage.pageNumber
          console.log(`First main content at physical page ${contentStartsAt}`)
        } else {
          // Method 4: Skip known front matter
          for (let i = 0; i < pageTexts.length; i++) {
            const page = pageTexts[i]
            if (page.type !== 'title' && 
                page.type !== 'toc' && 
                page.type !== 'preface' &&
                page.type !== 'blank' &&
                page.charCount > 500) {
              contentStartsAt = page.pageNumber
              console.log(`Content starts after front matter at page ${contentStartsAt}`)
              break
            }
          }
        }
      }
    }
    
    // Extract structured TOC if found
    let tocData = null
    const tocPages = pageTexts.filter(p => p.isTOC)
    if (tocPages.length > 0) {
      // Combine all TOC pages
      const fullTocText = tocPages.map(p => p.text).join('\n')
      tocData = extractTOC(fullTocText)
      console.log(`Extracted ${tocData.length} TOC entries`)
    }
    
    // Log analysis summary
    console.log('\n=== Document Structure Analysis ===')
    console.log(`Total pages: ${pageTexts.length}`)
    console.log(`Main content starts: page ${contentStartsAt}`)
    console.log(`Title pages: ${pageTexts.filter(p => p.isTitle).map(p => p.pageNumber).join(', ') || 'none'}`)
    console.log(`TOC pages: ${pageTexts.filter(p => p.isTOC).map(p => p.pageNumber).join(', ') || 'none'}`)
    console.log(`Preface pages: ${pageTexts.filter(p => p.isPreface).map(p => p.pageNumber).join(', ') || 'none'}`)
    console.log(`Pages with numbers: ${pageTexts.filter(p => p.hasPageNumber).length}`)
    console.log(`  - Roman numerals: ${pageTexts.filter(p => p.pageNumberType === 'roman').length}`)
    console.log(`  - Arabic numbers: ${pageTexts.filter(p => p.pageNumberType === 'arabic').length}`)
    
    // Show page number mapping if available
    const pageMapping = pageTexts
      .filter(p => p.hasPageNumber)
      .slice(0, 10) // First 10 for brevity
      .map(p => {
        if (p.pageNumberType === 'roman') {
          return `Physical ${p.pageNumber} = Page ${p.romanNumeral} (Roman)`
        } else {
          return `Physical ${p.pageNumber} = Page ${p.actualPageNumber}`
        }
      })
    if (pageMapping.length > 0) {
      console.log(`\nPage number mapping (first 10):`)
      pageMapping.forEach(m => console.log(`  ${m}`))
    }
    
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
        content_starts_at: contentStartsAt,
        metadata: {
          title_pages: pageTexts.filter(p => p.isTitle).map(p => p.pageNumber),
          toc_pages: pageTexts.filter(p => p.isTOC).map(p => p.pageNumber),
          preface_pages: pageTexts.filter(p => p.isPreface).map(p => p.pageNumber),
          page_mapping: pageTexts
            .filter(p => p.hasPageNumber)
            .map(p => ({ 
              physical: p.pageNumber, 
              printed: p.pageNumberType === 'roman' ? p.romanNumeral : p.actualPageNumber,
              type: p.pageNumberType 
            })),
          toc_entries: tocData,
          pdf_info: pdfData.info
        }
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
      is_main_content: page.isMainContent || false,
      page_type: page.type,
      char_count: page.charCount,
      actual_page_number: page.actualPageNumber
      // Note: embedding will be generated separately if needed
    }))
    
    const { error: pagesError } = await supabase
      .from('pdf_pages')
      .insert(pageRecords)
    
    if (pagesError) {
      console.error('Pages insert error:', pagesError)
      throw pagesError
    }
    
    console.log(`\n✅ Saved PDF ${pdfRecord.id} with ${pageTexts.length} pages`)
    
    // Create full text with page markers and metadata for display
    let fullText = ''
    pageTexts.forEach(page => {
      let pageLabel
      if (page.pageNumberType === 'roman') {
        pageLabel = `Page ${page.romanNumeral} (physical ${page.pageNumber})`
      } else if (page.actualPageNumber) {
        pageLabel = `Page ${page.actualPageNumber} (physical ${page.pageNumber})`
      } else {
        pageLabel = `Page ${page.pageNumber}`
      }
      const typeLabel = page.type !== 'unknown' ? ` [${page.type}]` : ''
      fullText += `\n--- ${pageLabel}${typeLabel} ---\n${page.text}\n`
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
        pageAnalysis: pageTexts.map(p => ({
          page: p.pageNumber,
          type: p.type,
          confidence: p.confidence,
          actualNumber: p.actualPageNumber
        })),
        tocEntries: tocData,
        info: pdfData.info
      }
    })
    
  } catch (error) {
    console.error('Error extracting text:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}