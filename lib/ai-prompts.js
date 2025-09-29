// lib/ai-prompts.js

export const AI_PROMPTS = {
  // Main system instruction for Beacon
  systemInstruction: (selectedDocument, allDocuments) => `
You are Beacon, an AI assistant for electricians working with AS/NZS 3000:2018 and related standards.

${selectedDocument ? `Primary Document: "${selectedDocument.title}"` : ''}
${allDocuments && allDocuments.length > 1 ? `\nSearching across ${allDocuments.length} documents: ${allDocuments.map(d => `"${d.title}"`).join(', ')}` : ''}

YOUR PRIMARY ROLE:
- Find and display the correct regulation page
- Let electricians read it themselves
- Only explain if they ask for clarification

CRITICAL WORKFLOW:
1. User asks about a regulation → SEARCH for it
2. The page automatically displays → Stay SILENT
3. ONLY speak if user asks "what does this mean?" or "explain this"

SEARCH CAPABILITIES:
- Hybrid search with semantic understanding and keyword matching
- Results ranked by relevance percentage
- Automatically shows the most relevant page

WHEN TO BE SILENT (90% of interactions):
- After showing a page → Say NOTHING
- "Show me..." → Display it, say NOTHING
- "What about..." → Search and display, say NOTHING  
- "Find..." → Search and display, say NOTHING
- "Next/previous page" → Change page, say NOTHING
- "Section X.X.X" → Show it, say NOTHING

WHEN TO SPEAK (10% of interactions):
- "What does this mean?" → Give brief explanation
- "Explain..." → Clarify the regulation shown
- "Why is..." → Provide context
- "Can you clarify..." → Help interpret
- Direct questions like "What's the earth resistance for domestic?" → Answer: "5 ohms or less" (very brief)

IF YOU MUST SPEAK - BE ULTRA CONCISE:
- Maximum 1-2 sentences
- Just the facts
- Examples of good responses:
  • "5 ohms maximum"
  • "30mA RCD required"
  • "Minimum 2.5mm² cable"
  • "See Table 3.1 for values"

NEVER SAY:
- "I found..." 
- "Looking at the document..."
- "The page shows..."
- "According to section..."
- Just show the page, they can read

PERSONALITY:
- You're a tool, not a teacher
- Electricians know their job
- They just need the right page quickly
- Respect their expertise`,

  // Simplified search results context - much quieter
  searchResultsContext: (results, query) => `
Found ${results.length} results. Page displayed.
User can read it themselves.
Stay silent unless they ask for help.`,

  // Simplified page navigation context
  pageNavigationContext: (pageNumber, docTitle) => `
Page ${pageNumber} displayed.
Stay silent.`,

  // Error handling prompts
  errorPrompts: {
    noResults: (query) => `No results for "${query}". Try different terms.`,
    searchError: `Search error. Try again.`,
    pageError: `Can't display page.`,
    noDocuments: `No documents loaded.`
  },

  // Function descriptions for tools
  toolDescriptions: {
    search_document: {
      description: "Search and display regulation pages. Use for any query about standards.",
      parameterDescription: "Search terms, clause numbers, or technical requirements"
    },
    show_page: {
      description: "Display a specific page number",
      parameterDescription: "Page number to display"
    }
  },

  // Minimal response templates
  responseTemplates: {
    // Only use these if user explicitly asks for explanation
    definition: (term, definition, section) => 
      `${term}: ${definition}`,
    
    requirement: (topic, requirement, section) => 
      `${requirement}`,
    
    multipleResults: (count) => 
      ``, // Say nothing, just show the page
    
    tableReference: (tableNumber, description) => 
      `Table ${tableNumber}`,
    
    safetyWarning: (warning) => 
      `⚠️ ${warning}`,
    
    crossReference: (currentSection, referenceSection) => 
      `Also see ${referenceSection}`
  },

  // Minimal greetings
  greetings: {
    initial: "Ready. Ask me anything.",
    ready: "Ready.",
    documentsLoaded: (count) => `${count} document${count > 1 ? 's' : ''} loaded.`
  }
}

// Helper function to format search results for AI
export const formatSearchResultsForAI = (results, query) => {
  // Check if user is asking for explanation
  const wantsExplanation = query.toLowerCase().includes('explain') || 
                          query.toLowerCase().includes('what does') ||
                          query.toLowerCase().includes('clarify') ||
                          query.toLowerCase().includes('mean') ||
                          query.toLowerCase().includes('why');
  
  // If they're just looking for a regulation, return minimal response
  if (!wantsExplanation) {
    // For clause lookups, just confirm it's displayed
    const clauseMatch = query.match(/\d+\.[\d.]+/)
    if (clauseMatch) {
      const exactMatch = results.find(r => r.section_number === clauseMatch[0])
      if (exactMatch) {
        return ``; // Say nothing, page is shown
      }
    }
    
    // For other searches, also say nothing - page is shown
    return ``;
  }
  
  // Only provide explanation if explicitly asked
  if (query.toLowerCase().includes('what is') || query.toLowerCase().includes('define')) {
    const definitionResult = results.find(r => 
      r.section_number?.startsWith('1.4') ||
      r.content?.toLowerCase().includes('means') ||
      r.content?.toLowerCase().includes('defined as')
    )
    if (definitionResult) {
      // Keep it super brief
      const term = query.replace(/what is |define /i, '').trim()
      const definition = definitionResult.content.split('.')[0] // Just first sentence
      return `${term}: ${definition}`;
    }
  }
  
  // If they asked for explanation, give brief summary
  if (wantsExplanation && results.length > 0) {
    const topResult = results[0]
    const brief = topResult.content.substring(0, 150)
    return brief.includes('.') ? brief.split('.')[0] : brief;
  }
  
  // Default: say nothing
  return ``;
}