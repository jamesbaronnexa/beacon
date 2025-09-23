'use client'
import { useState, useRef, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { supabase } from '../lib/supabase'

// Dynamically import PDFViewer to avoid SSR issues
const PDFViewer = dynamic(() => import('./PDFViewer'), { 
  ssr: false,
  loading: () => <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center"><div className="text-white">Loading PDF viewer...</div></div>
})

export default function BeaconRealtimeVoice({ allDocuments, category, autoStart }) {
  const [state, setState] = useState('idle')
  const [status, setStatus] = useState('Click Start to begin')
  const [transcript, setTranscript] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  const [lastSearchResults, setLastSearchResults] = useState([])
  const [selectedDocument, setSelectedDocument] = useState(() => {
    // Initialize with first document immediately
    return allDocuments && allDocuments.length > 0 ? allDocuments[0] : null
  })
  const [currentlyLoadedDoc, setCurrentlyLoadedDoc] = useState(null) // Track which PDF is loaded
  
  // PDF Viewer state - separate URL and page number
  const [pdfUrl, setPdfUrl] = useState(null)
  const [currentPageNumber, setCurrentPageNumber] = useState(1)
  const [isPdfViewerOpen, setIsPdfViewerOpen] = useState(false)
  
  // WebRTC refs
  const pcRef = useRef(null)
  const dcRef = useRef(null)
  const localStreamRef = useRef(null)
  const audioContextRef = useRef(null)
  const animationFrameRef = useRef(null)
  
  // Use refs to persist document state
  const selectedDocumentRef = useRef(selectedDocument)
  const currentlyLoadedDocRef = useRef(currentlyLoadedDoc)

  // Keep refs in sync with state
  useEffect(() => {
    selectedDocumentRef.current = selectedDocument
  }, [selectedDocument])
  
  useEffect(() => {
    currentlyLoadedDocRef.current = currentlyLoadedDoc
  }, [currentlyLoadedDoc])
  
  // Initialize selectedDocument when allDocuments changes or component mounts
  useEffect(() => {
    if (allDocuments && allDocuments.length > 0) {
      if (!selectedDocument || !allDocuments.find(d => d.id === selectedDocument.id)) {
        console.log('Setting selectedDocument to first document:', allDocuments[0].title)
        setSelectedDocument(allDocuments[0])
        selectedDocumentRef.current = allDocuments[0]
      }
    }
  }, [allDocuments])

  // Initialize PDF URL only when explicitly showing a page
  // Remove the automatic initialization effect
  useEffect(() => {
    // Don't auto-initialize any PDF - wait for actual page show request
    console.log('Component ready with documents:', allDocuments?.length || 0)
  }, [])

  // Get PDF context for the AI
  const getPdfContext = async () => {
    if (!selectedDocument) return '';
    
    try {
      // Get first few pages of content
      const { data } = await supabase
        .from('pages')
        .select('pdf_page_number, content')
        .eq('document_id', selectedDocument.id)
        .eq('is_content', true)  // Only get actual content pages
        .order('pdf_page_number')
        .limit(3)
      
      if (data && data.length > 0) {
        return data.map(p => 
          `Page ${p.pdf_page_number}: ${p.content.substring(0, 500)}...`
        ).join('\n\n')
      }
    } catch (error) {
      console.error('Error getting PDF context:', error)
    }
    return ''
  }

  // Get page offset from database
  const getPageOffset = () => {
    // Use the content_starts_at_page field from the document record
    // If content starts at page 3, we need offset of -2 (to go from page 3 to page 1)
    if (selectedDocument && selectedDocument.content_starts_at_page) {
      return -(selectedDocument.content_starts_at_page - 1)
    }
    return 0
  }
  
  // Handle showing a specific page with proper offset
  const handleShowPage = async (pageNumber, targetDocument = null) => {
    // If no target document provided, try to use selectedDocument
    const docToUse = targetDocument || selectedDocument
    
    if (!docToUse) {
      console.error('No document available to show page')
      return
    }
    
    console.log(`Request to show page ${pageNumber} from document: ${docToUse.title} (ID: ${docToUse.id})`)
    
    // Get the PDF URL for the document we want to show
    const originalFilename = docToUse.filename.replace('pdfs/', '')
    
    const { data: files } = await supabase.storage
      .from('pdfs')
      .list()
    
    let actualFilename = originalFilename
    if (files) {
      const matchingFile = files.find(f => 
        f.name === originalFilename || 
        f.name.endsWith(`-${originalFilename}`)
      )
      if (matchingFile) {
        actualFilename = matchingFile.name
        console.log(`Found PDF file: ${actualFilename}`)
      } else {
        console.error(`Could not find PDF file for: ${originalFilename}`)
        console.log('Available files:', files.map(f => f.name))
        return
      }
    }
    
    const { data } = await supabase.storage
      .from('pdfs')
      .getPublicUrl(actualFilename)
    
    if (data && data.publicUrl) {
      console.log(`Got PDF URL: ${data.publicUrl}`)
      
      // Check if we need to switch PDFs
      const needsNewPdf = !currentlyLoadedDocRef.current || currentlyLoadedDocRef.current.id !== docToUse.id
      
      if (needsNewPdf) {
        console.log(`Switching from ${currentlyLoadedDocRef.current?.title || 'none'} to ${docToUse.title}`)
        // Close the viewer first if switching documents
        if (isPdfViewerOpen && currentlyLoadedDocRef.current) {
          setIsPdfViewerOpen(false)
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        
        // Update which doc is loaded BEFORE setting the PDF URL
        setCurrentlyLoadedDoc(docToUse)
        currentlyLoadedDocRef.current = docToUse
      }
      
      // Update the PDF URL
      setPdfUrl(data.publicUrl)
      
      // If explicitly switching documents, update selectedDocument
      if (targetDocument && targetDocument.id !== selectedDocument?.id) {
        setSelectedDocument(targetDocument)
      }
      
      // Calculate the actual page number
      const offset = docToUse?.content_starts_at_page ? -(docToUse.content_starts_at_page - 1) : 0
      const actualPageNumber = pageNumber
      
      console.log(`Setting page to ${actualPageNumber} (AI called it page ${pageNumber + offset})`)
      
      // Update the page number
      setCurrentPageNumber(actualPageNumber)
      
      // Open viewer after a small delay to ensure PDF URL is set
      setTimeout(() => {
        if (!isPdfViewerOpen) {
          console.log('Opening PDF viewer')
          setIsPdfViewerOpen(true)
        }
      }, needsNewPdf ? 200 : 100)
    } else {
      console.error('Failed to get PDF URL for document:', docToUse.title)
    }
  }

  // Handle page changes from user navigation in the PDF viewer
  const handleUserPageChange = (newPage) => {
    console.log('User navigated to page:', newPage)
    setCurrentPageNumber(newPage)
    
    // Update status to show current page
    const offset = getPageOffset()
    const displayPage = newPage + offset
    setStatus(`Viewing page ${displayPage}`)
    
    // Inform the AI about the page change if connected
    if (dcRef.current && dcRef.current.readyState === 'open') {
      const pageChangeMessage = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [
            {
              type: 'text',
              text: `User manually navigated to page ${displayPage}`
            }
          ]
        }
      }
      
      // Send the system message to inform AI of page change
      dcRef.current.send(JSON.stringify(pageChangeMessage))
      console.log('Informed AI about page navigation to:', displayPage)
    }
  }

  const startSession = async () => {
    // Prevent double-starting
    if (state !== 'idle') {
      console.log('Session already active, skipping start')
      return
    }
    
    try {
      setState('connecting')
      setStatus('Getting microphone...')
      
      // Get microphone
      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      })
      localStreamRef.current = localStream
      
      setStatus('Connecting to GPT-4o Realtime...')
      
      // Create WebRTC peer connection
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
        ]
      })
      pcRef.current = pc
      
      // Add audio track
      const audioTrack = localStream.getAudioTracks()[0]
      pc.addTrack(audioTrack, localStream)
      
      // Handle remote audio
      pc.ontrack = (event) => {
        console.log('Received remote audio track')
        const audio = document.createElement('audio')
        audio.srcObject = event.streams[0]
        audio.autoplay = true
        audio.id = 'beacon-realtime-audio'
        document.body.appendChild(audio)
      }
      
      // Create data channel for events
      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      
      dc.onopen = async () => {
        console.log('Data channel opened!')
        setState('connected')
        setStatus('Connected! Ask your questions')
        
        // Send initial configuration with search function
        const sessionConfig = {
          type: "session.update",
          session: {
            modalities: ["audio", "text"],
            voice: "alloy",
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500
            },
            instructions: `You are Beacon, an AI assistant and the electrician's trusted companion for regulations. You're knowledgeable, helpful, and act like a friendly tutor who knows these documents inside out.
            
            ${selectedDocument ? `Primary Document: "${selectedDocument.title}"` : ''}
            ${allDocuments && allDocuments.length > 1 ? `\nSearching across ${allDocuments.length} documents: ${allDocuments.map(d => `"${d.title}"`).join(', ')}` : ''}
            
            CRITICAL WORKFLOW - ALWAYS FOLLOW THIS ORDER:
            1. When asked a question: SEARCH first
            2. The search automatically shows the relevant page
            3. Then explain what you found - CONCISELY
            4. DO NOT explain without showing the page first
            
            YOUR PERSONALITY:
            - Friendly electrician's assistant
            - Professional and knowledgeable
            - Get to the point quickly
            
            RESPONSE LENGTH - Be concise:
            - 1-2 sentences for most answers
            - Only add a third sentence if it's critical safety/compliance info
            - Examples of good concise responses:
              "You need 240V AC with a 32A breaker."
              "Earth resistance must be 5 ohms or less."
              "Maximum demand is 100A, see the table below."
              "RCDs need to be 30mA for wet areas."
            
            PAGE NAVIGATION RULES - BE SILENT:
            - "next page" or "previous page" → Just change pages, say NOTHING
            - "show me page X" → Just show it, say NOTHING
            - "go to..." → Just go there, say NOTHING
            - ONLY speak if user asks "what's on this page?" or similar
            
            NEVER MENTION:
            - Page numbers (user can see them)
            - Document names (unless conflicting info exists)
            - Phrases like "Looking at page..." or "This page shows..."
            - Just give the answer directly
            
            ONLY mention documents when:
            - Different documents have DIFFERENT requirements
            - Example: "Residential needs 5 ohms, commercial needs 2 ohms"
            
            BE PRACTICAL:
            - Answer like you're on a job site
            - Focus on what the electrician needs to know
            - Add safety warnings only if critical
            
            Remember: Be helpful but CONCISE. When navigating pages, be SILENT unless asked to explain.`,
            tools: [
              {
                type: "function",
                name: "search_document",
                description: "Search the document for specific keywords or phrases",
                parameters: {
                  type: "object",
                  properties: {
                    query: {
                      type: "string",
                      description: "The search term or phrase to look for in the document"
                    }
                  },
                  required: ["query"]
                }
              },
              {
                type: "function", 
                name: "show_page",
                description: "Display a specific page of the document",
                parameters: {
                  type: "object",
                  properties: {
                    page_number: {
                      type: "number",
                      description: "The page number to display"
                    }
                  },
                  required: ["page_number"]
                }
              }
            ]
          }
        }
        
        dc.send(JSON.stringify(sessionConfig))
      }
      
      dc.onmessage = async (event) => {
        const msg = JSON.parse(event.data)
        
        // Handle function calls from the AI
        if (msg.type === 'response.function_call_arguments.done') {
          console.log('AI wants to:', msg.name, msg)
          
          if (msg.name === 'search_document') {
            try {
              const args = JSON.parse(msg.arguments)
              const searchQuery = args.query
              
              console.log('Searching documents for:', searchQuery)
              setStatus(`Searching for: ${searchQuery}`)
              
              // Use all documents passed to the component
              const documentsToSearch = allDocuments && allDocuments.length > 0 
                ? allDocuments 
                : []
              
              if (documentsToSearch.length === 0) {
                throw new Error('No documents available to search')
              }
              
              console.log(`Searching across ${documentsToSearch.length} documents:`, documentsToSearch.map(d => d.title))
              
              // Multi-stage search strategy across all documents
              let allSearchResults = []
              let searchMethod = ''
              
              // Search each document
              for (const doc of documentsToSearch) {
                console.log(`Searching in: ${doc.title}`)
                
                // Stage 1: Exact phrase search (case-insensitive) - ONLY IN CONTENT PAGES
                const { data: exactResults, error: exactError } = await supabase
                  .from('pages')
                  .select('pdf_page_number, content, section_title, section_number, document_id')
                  .eq('document_id', doc.id)
                  .eq('is_content', true)  // Only search actual content pages!
                  .ilike('content', `%${searchQuery}%`)
                  .order('pdf_page_number', { ascending: true })
                  .limit(3) // Limit per document to avoid overwhelming results
                
                if (!exactError && exactResults && exactResults.length > 0) {
                  // Add document info to each result
                  const resultsWithDoc = exactResults.map(r => ({
                    ...r,
                    document_title: doc.title,
                    document_filename: doc.filename,
                    content_offset: doc.content_starts_at_page || 1
                  }))
                  allSearchResults.push(...resultsWithDoc)
                  searchMethod = 'exact'
                }
              }
              
              // Stage 2: If no exact matches, try word-based search
              if (allSearchResults.length === 0) {
                console.log('No exact matches, trying word-by-word search...')
                const words = searchQuery.split(' ').filter(w => w.length > 2)
                
                if (words.length > 0) {
                  for (const doc of documentsToSearch) {
                    let wordResults = []
                    for (const word of words) {
                      const { data: wordData } = await supabase
                        .from('pages')
                        .select('pdf_page_number, content, section_title, section_number, document_id')
                        .eq('document_id', doc.id)
                        .eq('is_content', true)  // Only search actual content pages!
                        .ilike('content', `%${word}%`)
                        .order('pdf_page_number', { ascending: true })
                        .limit(2)
                      
                      if (wordData) {
                        wordResults.push(...wordData)
                      }
                    }
                    
                    // Deduplicate and score results
                    const pageScores = {}
                    wordResults.forEach(result => {
                      const key = `${doc.id}-${result.pdf_page_number}`
                      if (!pageScores[key]) {
                        pageScores[key] = {
                          ...result,
                          document_title: doc.title,
                          document_filename: doc.filename,
                          content_offset: doc.content_starts_at_page || 1,
                          score: 0
                        }
                      }
                      // Count how many search words appear
                      words.forEach(word => {
                        if (result.content.toLowerCase().includes(word.toLowerCase())) {
                          pageScores[key].score++
                        }
                      })
                    })
                    
                    // Add top scoring results from this document
                    const scoredResults = Object.values(pageScores)
                      .sort((a, b) => b.score - a.score)
                      .slice(0, 2)
                    
                    if (scoredResults.length > 0) {
                      allSearchResults.push(...scoredResults)
                      searchMethod = 'word-based'
                    }
                  }
                }
              }
              
              // Stage 3: If still no results, try fuzzy/partial matching
              if (allSearchResults.length === 0) {
                console.log('Trying partial word matching...')
                const mainWord = searchQuery.split(' ')
                  .filter(w => w.length > 2)
                  .sort((a, b) => b.length - a.length)[0]
                
                if (mainWord) {
                  for (const doc of documentsToSearch) {
                    const partialWord = mainWord.substring(0, Math.max(4, mainWord.length - 2))
                    const { data: partialResults } = await supabase
                      .from('pages')
                      .select('pdf_page_number, content, section_title, section_number, document_id')
                      .eq('document_id', doc.id)
                      .eq('is_content', true)  // Only search actual content pages!
                      .ilike('content', `%${partialWord}%`)
                      .order('pdf_page_number', { ascending: true })
                      .limit(2)
                    
                    if (partialResults && partialResults.length > 0) {
                      const resultsWithDoc = partialResults.map(r => ({
                        ...r,
                        document_title: doc.title,
                        document_filename: doc.filename,
                        content_offset: doc.content_starts_at_page || 1
                      }))
                      allSearchResults.push(...resultsWithDoc)
                      searchMethod = 'partial'
                    }
                  }
                }
              }
              
              // Sort all results by relevance (if scored) or keep original order
              if (searchMethod === 'word-based') {
                allSearchResults.sort((a, b) => (b.score || 0) - (a.score || 0))
              }
              
              // Limit total results
              const finalResults = allSearchResults.slice(0, 5)
              
              // Store search results for display - now includes document info
              if (finalResults.length > 0) {
                setLastSearchResults(finalResults.slice(0, 3))
                
                // Auto-show the first result with the correct document
                const firstResult = finalResults[0]
                const targetDoc = documentsToSearch.find(d => d.id === firstResult.document_id)
                if (targetDoc) {
                  console.log(`Search found result in document: ${targetDoc.title}`)
                  
                  // Update selectedDocument if it's different
                  const currentSelected = selectedDocumentRef.current
                  if (!currentSelected || currentSelected.id !== targetDoc.id) {
                    console.log(`Updating selectedDocument from ${currentSelected?.title || 'none'} to ${targetDoc.title}`)
                    setSelectedDocument(targetDoc)
                    selectedDocumentRef.current = targetDoc
                  }
                  
                  // Small delay before showing page to ensure everything is ready
                  setTimeout(() => {
                    handleShowPage(firstResult.pdf_page_number, targetDoc)
                  }, 300)
                } else {
                  console.error('Could not find document for search result:', firstResult.document_id)
                }
              }
              
              // Format results for the AI
              let resultText = ''
              
              if (finalResults.length > 0) {
                // Group results by document if multiple documents
                if (documentsToSearch.length > 1) {
                  const resultsByDoc = {}
                  finalResults.forEach(result => {
                    if (!resultsByDoc[result.document_title]) {
                      resultsByDoc[result.document_title] = []
                    }
                    resultsByDoc[result.document_title].push(result)
                  })
                  
                  resultText = Object.entries(resultsByDoc).map(([docTitle, docResults]) => {
                    const docText = docResults.map(result => {
                      const offset = -(result.content_offset - 1)
                      const actualPageNum = result.pdf_page_number + offset
                      const snippet = result.content.substring(0, 200)
                      const sectionInfo = result.section_title ? ` (Section ${result.section_number}: ${result.section_title})` : ''
                      return `Page ${actualPageNum}${sectionInfo}: ...${snippet}...`
                    }).join('\n')
                    
                    return `In "${docTitle}":\n${docText}`
                  }).join('\n\n')
                } else {
                  // Single document results
                  resultText = finalResults.map(result => {
                    const offset = -(result.content_offset - 1)
                    const actualPageNum = result.pdf_page_number + offset
                    const snippet = result.content.substring(0, 200)
                    const sectionInfo = result.section_title ? ` (Section ${result.section_number}: ${result.section_title})` : ''
                    return `Page ${actualPageNum}${sectionInfo}: ...${snippet}...`
                  }).join('\n\n')
                }
                
                if (searchMethod === 'word-based') {
                  resultText = `Found pages containing these related terms:\n${resultText}`
                }
              } else {
                resultText = `No results found for "${searchQuery}" in the ${documentsToSearch.length} document(s). Try different search terms.`
              }
              
              console.log(`Search complete (${searchMethod}):`, resultText.substring(0, 200) + '...')
              
              // Send results back to the AI
              const functionOutput = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: msg.call_id,
                  output: resultText
                }
              }
              
              dc.send(JSON.stringify(functionOutput))
              
              // Tell the AI to respond now
              const createResponse = {
                type: 'response.create'
              }
              
              dc.send(JSON.stringify(createResponse))
              
            } catch (error) {
              console.error('Search error:', error)
              
              // Send error back to AI
              const errorOutput = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: msg.call_id,
                  output: `Error searching: ${error.message}`
                }
              }
              
              dc.send(JSON.stringify(errorOutput))
              
              // Tell AI to respond
              const createResponse = {
                type: 'response.create'
              }
              
              dc.send(JSON.stringify(createResponse))
            }
          } else if (msg.name === 'show_page') {
            // Handle page display request
            try {
              const args = JSON.parse(msg.arguments)
              const pageNumber = parseInt(args.page_number)
              
              console.log('AI wants to show page:', pageNumber)
              
              // For direct page requests, we need to figure out which document
              let docToShow = selectedDocumentRef.current || (allDocuments && allDocuments.length > 0 ? allDocuments[0] : null)
              
              console.log('Show page request - Available documents:', allDocuments?.length)
              console.log('Current selectedDocument (ref):', selectedDocumentRef.current?.title)
              console.log('Current selectedDocument (state):', selectedDocument?.title)
              
              // If we have recent search results, the page is probably from that search
              if (lastSearchResults.length > 0) {
                console.log('Checking recent search results for context')
                
                // Get the most recent search result to determine document context
                const mostRecentResult = lastSearchResults[0]
                if (mostRecentResult && allDocuments) {
                  const resultDoc = allDocuments.find(d => d.id === mostRecentResult.document_id)
                  if (resultDoc) {
                    console.log(`Using document from recent search: ${resultDoc.title}`)
                    docToShow = resultDoc
                  }
                }
              } else if (!docToShow && currentlyLoadedDocRef.current) {
                // If no search context and no selected document, use the currently loaded one
                console.log('Using currently loaded document:', currentlyLoadedDocRef.current.title)
                docToShow = currentlyLoadedDocRef.current
              }
              
              if (!docToShow) {
                console.error('No document available for page display')
                console.error('selectedDocument (ref):', selectedDocumentRef.current)
                console.error('selectedDocument (state):', selectedDocument)
                console.error('allDocuments:', allDocuments)
                console.error('currentlyLoadedDoc:', currentlyLoadedDocRef.current)
                throw new Error('No document available')
              }
              
              console.log(`Will show page ${pageNumber} from document: ${docToShow.title}`)
              
              // Apply offset to get the correct database page
              const offset = docToShow.content_starts_at_page ? -(docToShow.content_starts_at_page - 1) : 0
              const dbPageNumber = pageNumber - offset  // Convert from spoken page to DB page
              
              // Show the page with the correct document
              handleShowPage(dbPageNumber, docToShow)
              
              // Send confirmation back to AI with context hint
              const functionOutput = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: msg.call_id,
                  output: `Now showing page ${pageNumber} from ${docToShow.title}. The page is displayed for the user.`
                }
              }
              
              dc.send(JSON.stringify(functionOutput))
              
              // Send a system message to update context about what's on screen
              const contextUpdate = {
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'system',
                  content: [
                    {
                      type: 'text',
                      text: `Page ${pageNumber} is now displayed. If the user asks about "next page" or "previous page", they mean relative to page ${pageNumber}. Only explain this new page's content if the user asks about it.`
                    }
                  ]
                }
              }
              
              dc.send(JSON.stringify(contextUpdate))
              
              // Tell AI to respond only if needed
              const createResponse = {
                type: 'response.create'
              }
              
              dc.send(JSON.stringify(createResponse))
              
            } catch (error) {
              console.error('Page display error:', error)
              
              // Send error back to AI
              const errorOutput = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: msg.call_id,
                  output: `Error displaying page: ${error.message}`
                }
              }
              
              dc.send(JSON.stringify(errorOutput))
              
              const createResponse = {
                type: 'response.create'
              }
              
              dc.send(JSON.stringify(createResponse))
            }
          }
        }
        
        // Handle different message types
        if (msg.type === 'conversation.item.created') {
          if (msg.item && msg.item.role === 'user') {
            // User's speech transcribed
            const userText = msg.item.content?.[0]?.transcript || 
                           msg.item.formatted?.transcript || 
                           ''
            if (userText) {
              setTranscript(userText)
              setAiResponse('') // Clear previous response
            }
          }
        }
        
        if (msg.type === 'response.content_part.added') {
          if (msg.part && msg.part.transcript) {
            // AI's response
            setAiResponse(prev => prev + msg.part.transcript)
          }
        }
        
        if (msg.type === 'response.done') {
          // Response complete
          console.log('AI response complete')
          setStatus('Connected! Continue talking...')
        }
        
        if (msg.type === 'error') {
          console.error('Realtime error:', msg.error || 'Unknown error')
          setStatus(`Error: ${msg.error?.message || 'Unknown error'}`)
        }
      }
      
      dc.onerror = (error) => {
        console.error('Data channel error:', error)
        setState('error')
        setStatus('Connection error')
      }
      
      // Create offer
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      
      // Wait for ICE gathering
      await new Promise((resolve) => {
        let hasCandidate = false
        
        pc.onicecandidate = (event) => {
          if (event.candidate && !hasCandidate) {
            hasCandidate = true
            setTimeout(resolve, 100)
          }
        }
        
        if (pc.iceGatheringState === 'complete') {
          resolve()
        }
        
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') {
            resolve()
          }
        }
        
        // Timeout fallback
        setTimeout(resolve, 2000)
      })
      
      setStatus('Establishing connection...')
      
      // Send offer to our API
      const response = await fetch('/api/realtime/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          sdp: pc.localDescription.sdp,
          pdfContext: selectedDocument?.title || null
        })
      })
      
      if (!response.ok) {
        const error = await response.text()
        throw new Error(`Server error: ${error}`)
      }
      
      const { sdp: answer } = await response.json()
      
      // Set remote description
      await pc.setRemoteDescription({ 
        type: 'answer', 
        sdp: answer 
      })
      
      console.log('WebRTC connection established!')
      
    } catch (error) {
      console.error('Session error:', error)
      setState('error')
      setStatus(`Error: ${error.message}`)
      stopSession()
    }
  }
  
  const stopSession = () => {
    // Clean up audio element
    const audio = document.getElementById('beacon-realtime-audio')
    if (audio) {
      audio.remove()
    }
    
    // Close connections
    if (dcRef.current) {
      dcRef.current.close()
      dcRef.current = null
    }
    
    if (pcRef.current) {
      pcRef.current.close()
      pcRef.current = null
    }
    
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop())
      localStreamRef.current = null
    }
    
    setState('idle')
    setStatus('Disconnected')
    setTranscript('')
    setAiResponse('')
  }
  
  // Auto-start if requested (only once)
  useEffect(() => {
    if (autoStart && state === 'idle') {
      const timer = setTimeout(() => {
        if (state === 'idle') {  // Double-check still idle
          startSession()
        }
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [autoStart])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopSession()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-4">
      <div className="p-6 bg-gradient-to-br from-blue-50 to-purple-50 rounded-xl shadow-lg">
        <h3 className="text-xl font-bold mb-4">GPT-4o Realtime Voice Search</h3>
        
        <div className="mb-4">
          <p className="text-sm text-gray-600">{status}</p>
        </div>
        
        {transcript && (
          <div className="mb-3 p-3 bg-white rounded-lg">
            <p className="text-sm"><strong>You:</strong> {transcript}</p>
          </div>
        )}
        
        {aiResponse && (
          <div className="mb-3 p-3 bg-blue-50 rounded-lg">
            <p className="text-sm"><strong>Beacon:</strong> {aiResponse}</p>
          </div>
        )}
        
        <div className="flex gap-3">
          {state === 'idle' && (
            <button
              onClick={startSession}
              className="flex-1 py-3 px-6 bg-blue-500 text-white font-semibold rounded-lg hover:bg-blue-600 transition"
            >
              🎤 Start Voice Chat
            </button>
          )}
          
          {state === 'connecting' && (
            <div className="flex-1 py-3 px-6 bg-yellow-500 text-white font-semibold rounded-lg text-center animate-pulse">
              Connecting...
            </div>
          )}
          
          {state === 'connected' && (
            <>
              <div className="flex-1 py-3 px-6 bg-green-500 text-white font-semibold rounded-lg text-center">
                🎤 Listening - Just speak!
              </div>
              <button
                onClick={stopSession}
                className="py-3 px-6 bg-red-500 text-white font-semibold rounded-lg hover:bg-red-600"
              >
                Stop
              </button>
            </>
          )}
          
          {state === 'error' && (
            <button
              onClick={startSession}
              className="flex-1 py-3 px-6 bg-red-500 text-white font-semibold rounded-lg hover:bg-red-600"
            >
              Retry Connection
            </button>
          )}
        </div>
      </div>
      
      {/* Recent Search Results with View Page buttons */}
      {lastSearchResults.length > 0 && (
        <div className="p-4 bg-white rounded-xl shadow-lg">
          <h4 className="text-sm font-semibold mb-3 text-gray-700">Found on these pages:</h4>
          <div className="flex flex-wrap gap-2">
            {lastSearchResults.map((result, idx) => {
              const offset = result.content_offset ? -(result.content_offset - 1) : getPageOffset()
              const displayPageNum = result.pdf_page_number + offset
              const isFromCurrentDoc = result.document_id === selectedDocument?.id
              
              return (
                <button
                  key={idx}
                  onClick={() => {
                    // Always find the correct document for this result
                    const resultDoc = allDocuments?.find(d => d.id === result.document_id) || selectedDocument
                    if (resultDoc) {
                      console.log(`Clicking result from ${resultDoc.title}, page ${result.pdf_page_number}`)
                      handleShowPage(result.pdf_page_number, resultDoc)
                    }
                  }}
                  className={`px-3 py-1 rounded-lg text-sm font-medium transition ${
                    isFromCurrentDoc 
                      ? 'bg-blue-100 text-blue-700 hover:bg-blue-200' 
                      : 'bg-purple-100 text-purple-700 hover:bg-purple-200'
                  }`}
                >
                  📄 Page {displayPageNum}
                  {result.section_title && (
                    <span className="ml-1 text-xs opacity-75">
                      ({result.section_number})
                    </span>
                  )}
                  {result.document_title && allDocuments && allDocuments.length > 1 && (
                    <span className="ml-1 text-xs opacity-60">
                      - {result.document_title}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
      
      {/* PDF Viewer - Keep it mounted but hidden when not in use */}
      {pdfUrl && (
        <div style={{ display: isPdfViewerOpen ? 'block' : 'none' }}>
          <PDFViewer 
            url={pdfUrl}
            pageNumber={currentPageNumber}
            onClose={() => setIsPdfViewerOpen(false)}
            onPageChange={handleUserPageChange}
          />
        </div>
      )}
    </div>
  )
}