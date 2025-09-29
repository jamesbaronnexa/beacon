'use client'
import { useState, useRef, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { supabase } from '../lib/supabase'
import { AI_PROMPTS, formatSearchResultsForAI } from '../lib/ai-prompts'

// Dynamically import PDFViewer to avoid SSR issues
const PDFViewer = dynamic(() => import('./PDFViewer'), { 
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
      <div className="text-white">Loading PDF viewer...</div>
    </div>
  )
})

export default function BeaconRealtimeVoice({ allDocuments, category, autoStart }) {
  const [state, setState] = useState('idle')
  const [status, setStatus] = useState('Click Start to begin')
  const [transcript, setTranscript] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  const [lastSearchResults, setLastSearchResults] = useState([])
  const [selectedDocument, setSelectedDocument] = useState(() => {
    return allDocuments && allDocuments.length > 0 ? allDocuments[0] : null
  })
  const [currentlyLoadedDoc, setCurrentlyLoadedDoc] = useState(null)
  
  // PDF Viewer state
  const [pdfUrl, setPdfUrl] = useState(null)
  const [currentPageNumber, setCurrentPageNumber] = useState(1)
  const [isPdfViewerOpen, setIsPdfViewerOpen] = useState(false)
  
  // WebRTC refs
  const pcRef = useRef(null)
  const dcRef = useRef(null)
  const localStreamRef = useRef(null)
  
  // Persist document state in refs
  const selectedDocumentRef = useRef(selectedDocument)
  const currentlyLoadedDocRef = useRef(currentlyLoadedDoc)

  useEffect(() => {
    selectedDocumentRef.current = selectedDocument
  }, [selectedDocument])
  
  useEffect(() => {
    currentlyLoadedDocRef.current = currentlyLoadedDoc
  }, [currentlyLoadedDoc])
  
  // Initialize selectedDocument when allDocuments changes
  useEffect(() => {
    if (allDocuments && allDocuments.length > 0) {
      if (!selectedDocument || !allDocuments.find(d => d.id === selectedDocument.id)) {
        console.log('Setting selectedDocument to first document:', allDocuments[0].title)
        setSelectedDocument(allDocuments[0])
        selectedDocumentRef.current = allDocuments[0]
      }
    }
  }, [allDocuments])

  // --- Printed-vs-PDF page helpers ---
  function getPrintedOffsetFromDoc(doc) {
    // 1) preferred: top-level stored in documents.page_numbering
    const offTop = doc?.page_numbering?.printed_offset
    if (typeof offTop === 'number') return offTop

    // 2) fallback: if you ever nested it under nav_ranges.page_numbering
    const offNav = doc?.nav_ranges?.page_numbering?.printed_offset
    if (typeof offNav === 'number') return offNav

    // 3) infer from content_starts_at_page as last resort
    if (doc?.content_starts_at_page) return -(doc.content_starts_at_page - 1)

    return 0
  }

  function printedFromPdf(pdfPage, doc) {
    return pdfPage + getPrintedOffsetFromDoc(doc)
  }

  function pdfFromPrinted(printedPage, doc) {
    return printedPage - getPrintedOffsetFromDoc(doc)
  }

  // Hybrid search (no fallback)
  const performSearch = async (searchQuery) => {
    try {
      console.log('Performing hybrid search for:', searchQuery)
      
      const response = await fetch('/api/ai-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: searchQuery,
          documentIds: allDocuments?.map(d => d.id) || [],
          category: category,
          searchMode: 'hybrid'
        })
      })
      
      if (!response.ok) throw new Error('Search API error')
      
      const data = await response.json()
      
      if (data.results && data.results.length > 0) {
        console.log(`Hybrid search found ${data.results.length} results`)
        
        // Keep top 3 for UI chips
        const topResults = data.results.slice(0, 3).map(result => ({
          ...result,
          document_id: result.document_id,
          pdf_page_number: result.pdf_page_number,
          section_number: result.section_number,
          section_title: result.section_title,
          content: result.content,
          relevance_score: result.relevance_score
        }))
        setLastSearchResults(topResults)
        
        // Auto-show the first result
        const firstResult = data.results[0]
        const targetDoc = allDocuments?.find(d => d.id === firstResult.document_id)
        if (targetDoc) {
          console.log(`Auto-showing page ${firstResult.pdf_page_number} from ${targetDoc.title}`)
          if (selectedDocumentRef.current?.id !== targetDoc.id) {
            setSelectedDocument(targetDoc)
            selectedDocumentRef.current = targetDoc
          }
          setTimeout(() => {
            handleShowPage(firstResult.pdf_page_number, targetDoc)
          }, 300)
        }
        
        // Format results for the model
        return formatSearchResultsForAI(data.results, searchQuery)
      } else {
        return AI_PROMPTS.errorPrompts.noResults(searchQuery)
      }
    } catch (error) {
      console.error('Search error:', error)
      return AI_PROMPTS.errorPrompts.searchError
    }
  }

  // Show a specific (PDF) page in the viewer
  const handleShowPage = async (pageNumber, targetDocument = null) => {
    const docToUse = targetDocument || selectedDocument
    if (!docToUse) {
      console.error('No document available to show page')
      return
    }
    
    console.log(`Showing page ${pageNumber} from document: ${docToUse.title}`)
    
    const originalFilename = docToUse.filename.replace('pdfs/', '')
    const { data: files } = await supabase.storage.from('pdfs').list()
    
    let actualFilename = originalFilename
    if (files) {
      const matchingFile = files.find(f => 
        f.name === originalFilename || 
        f.name.endsWith(`-${originalFilename}`)
      )
      if (matchingFile) actualFilename = matchingFile.name
    }
    
    const { data } = await supabase.storage.from('pdfs').getPublicUrl(actualFilename)
    
    if (data && data.publicUrl) {
      const needsNewPdf = !currentlyLoadedDocRef.current || currentlyLoadedDocRef.current.id !== docToUse.id
      
      if (needsNewPdf) {
        if (isPdfViewerOpen && currentlyLoadedDocRef.current) {
          setIsPdfViewerOpen(false)
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        setCurrentlyLoadedDoc(docToUse)
        currentlyLoadedDocRef.current = docToUse
      }
      
      setPdfUrl(data.publicUrl)
      
      if (targetDocument && targetDocument.id !== selectedDocument?.id) {
        setSelectedDocument(targetDocument)
      }
      
      setCurrentPageNumber(pageNumber)
      
      setTimeout(() => {
        if (!isPdfViewerOpen) setIsPdfViewerOpen(true)
      }, needsNewPdf ? 200 : 100)
    }
  }

  // Handle user navigation inside the viewer
  const handleUserPageChange = (newPage) => {
    console.log('User navigated to page:', newPage)
    setCurrentPageNumber(newPage)
    
    const docForStatus = currentlyLoadedDocRef.current || selectedDocument
    const displayPrinted = printedFromPdf(newPage, docForStatus)
    setStatus(`Viewing page ${displayPrinted}`)
    
    if (dcRef.current && dcRef.current.readyState === 'open') {
      const pageChangeMessage = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [
            { type: 'input_text', text: `User manually navigated to printed page ${displayPrinted}` }
          ]
        }
      }
      dcRef.current.send(JSON.stringify(pageChangeMessage))
    }
  }

  const startSession = async () => {
    if (state !== 'idle') {
      console.log('Session already active')
      return
    }
    
    try {
      setState('connecting')
      setStatus('Getting microphone...')
      
      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
      localStreamRef.current = localStream
      
      setStatus('Connecting to GPT-4o Realtime...')
      
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      })
      pcRef.current = pc
      
      const audioTrack = localStream.getAudioTracks()[0]
      pc.addTrack(audioTrack, localStream)
      
      pc.ontrack = (event) => {
        console.log('Received remote audio track')
        const audio = document.createElement('audio')
        audio.srcObject = event.streams[0]
        audio.autoplay = true
        audio.id = 'beacon-realtime-audio'
        document.body.appendChild(audio)
      }
      
      const dc = pc.createDataChannel('oai-events')
      dcRef.current = dc
      
      dc.onopen = async () => {
        console.log('Data channel opened!')
        setState('connected')
        setStatus(AI_PROMPTS.greetings.documentsLoaded(allDocuments?.length || 0))
        
        // Session config
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
            instructions: AI_PROMPTS.systemInstruction(selectedDocument, allDocuments),
            tools: [
              {
                type: "function",
                name: "search_document",
                description: AI_PROMPTS.toolDescriptions.search_document.description,
                parameters: {
                  type: "object",
                  properties: {
                    query: {
                      type: "string",
                      description: AI_PROMPTS.toolDescriptions.search_document.parameterDescription
                    }
                  },
                  required: ["query"]
                }
              },
              {
                type: "function", 
                name: "show_page",
                description: AI_PROMPTS.toolDescriptions.show_page.description,
                parameters: {
                  type: "object",
                  properties: {
                    page_number: {
                      type: "number",
                      description: AI_PROMPTS.toolDescriptions.show_page.parameterDescription
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

        // Handle function calls
        if (msg.type === 'response.function_call_arguments.done') {
          console.log('AI function call:', msg.name, msg)
          
          if (msg.name === 'search_document') {
            try {
              const args = JSON.parse(msg.arguments)
              const searchQuery = args.query
              console.log('Searching for:', searchQuery)
              setStatus(`Searching for: ${searchQuery}`)
              
              const resultText = await performSearch(searchQuery)
              
              // Send function result
              dc.send(JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'function_call_output', call_id: msg.call_id, output: resultText }
              }))

              // One context message (no duplicate)
              const contextMessage = {
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'system',
                  content: [
                    { type: 'input_text', text: AI_PROMPTS.searchResultsContext(lastSearchResults, searchQuery) }
                  ]
                }
              }
              dc.send(JSON.stringify(contextMessage))
              
              // Let it respond
              dc.send(JSON.stringify({ type: 'response.create' }))
            } catch (error) {
              console.error('Search error:', error)
              dc.send(JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'function_call_output', call_id: msg.call_id, output: AI_PROMPTS.errorPrompts.searchError }
              }))
              dc.send(JSON.stringify({ type: 'response.create' }))
            }
          } 
          else if (msg.name === 'show_page') {
            try {
              const args = JSON.parse(msg.arguments)
              const printedPage = parseInt(args.page_number, 10)
              if (Number.isNaN(printedPage)) throw new Error('Invalid page number')

              // Pick the doc to show (prefer most recent search doc)
              let docToShow = selectedDocumentRef.current || allDocuments?.[0]
              if (lastSearchResults.length > 0 && allDocuments) {
                const resultDoc = allDocuments.find(d => d.id === lastSearchResults[0].document_id)
                if (resultDoc) docToShow = resultDoc
              }
              if (!docToShow) throw new Error('No document available')

              // Convert printed -> PDF, clamp to [1..total_pages]
              const dbPageNumber = pdfFromPrinted(printedPage, docToShow)
              const maxPage = docToShow?.total_pages || dbPageNumber
              const clamped = Math.max(1, Math.min(maxPage, dbPageNumber))

              handleShowPage(clamped, docToShow)

              // Function output
              dc.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: msg.call_id,
                  output: `Showing printed page ${printedPage} (PDF page ${clamped})`
                }
              }))

              // Context update (use input_text)
              dc.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'system',
                  content: [
                    { type: 'input_text', text: AI_PROMPTS.pageNavigationContext(printedPage, docToShow.title) }
                  ]
                }
              }))

              // Continue
              dc.send(JSON.stringify({ type: 'response.create' }))
            } catch (error) {
              console.error('Page display error:', error)
              dc.send(JSON.stringify({
                type: 'conversation.item.create',
                item: { type: 'function_call_output', call_id: msg.call_id, output: AI_PROMPTS.errorPrompts.pageError }
              }))
              dc.send(JSON.stringify({ type: 'response.create' }))
            }
          }
        }
        
        // Conversation updates
        if (msg.type === 'conversation.item.created') {
          if (msg.item && msg.item.role === 'user') {
            const userText =
              msg.item.content?.[0]?.transcript ||
              msg.item.formatted?.transcript ||
              ''
            if (userText) {
              setTranscript(userText)
              setAiResponse('')
            }
          }
        }
        
        if (msg.type === 'response.content_part.added') {
          if (msg.part && msg.part.transcript) {
            setAiResponse(prev => prev + msg.part.transcript)
          }
        }
        
        if (msg.type === 'response.done') {
          console.log('AI response complete')
          setStatus(AI_PROMPTS.greetings.ready)
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
        if (pc.iceGatheringState === 'complete') resolve()
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === 'complete') resolve()
        }
        setTimeout(resolve, 2000)
      })
      
      setStatus('Establishing connection...')
      
      // Send offer to API
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
      await pc.setRemoteDescription({ type: 'answer', sdp: answer })
      
      console.log('WebRTC connection established!')
      
    } catch (error) {
      console.error('Session error:', error)
      setState('error')
      setStatus(`Error: ${error.message}`)
      stopSession()
    }
  }
  
  const stopSession = () => {
    const audio = document.getElementById('beacon-realtime-audio')
    if (audio) audio.remove()
    
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
  
  // Auto-start if requested
  useEffect(() => {
    if (autoStart && state === 'idle') {
      const timer = setTimeout(() => {
        if (state === 'idle') startSession()
      }, 100)
      return () => clearTimeout(timer)
    }
  }, [autoStart, state]) // include state
  
  // Cleanup on unmount
  useEffect(() => {
    return () => { stopSession() }
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
      
      {/* Recent Search Results */}
      {lastSearchResults.length > 0 && (
        <div className="p-4 bg-white rounded-xl shadow-lg">
          <h4 className="text-sm font-semibold mb-3 text-gray-700">Search Results:</h4>
          <div className="flex flex-wrap gap-2">
            {lastSearchResults.map((result, idx) => {
              const resultDoc = allDocuments?.find(d => d.id === result.document_id) || selectedDocument
              const displayPageNum = printedFromPdf(result.pdf_page_number, resultDoc)
              const relevancePercent = result.relevance_score ? Math.round(result.relevance_score * 100) : 0
              
              return (
                <button
                  key={idx}
                  onClick={() => {
                    const doc = allDocuments?.find(d => d.id === result.document_id) || selectedDocument
                    if (doc) handleShowPage(result.pdf_page_number, doc)
                  }}
                  className="px-3 py-1 rounded-lg text-sm font-medium transition bg-blue-100 text-blue-700 hover:bg-blue-200"
                >
                  📄 Page {displayPageNum}
                  {result.section_title && (
                    <span className="ml-1 text-xs opacity-75">
                      ({result.section_number})
                    </span>
                  )}
                  {relevancePercent > 0 && (
                    <span className="ml-1 text-xs font-bold opacity-60">
                      {relevancePercent}%
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
      
      {/* PDF Viewer */}
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
