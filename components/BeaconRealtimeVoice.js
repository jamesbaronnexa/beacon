'use client'
import { useState, useRef, useEffect, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { supabase } from '../lib/supabase'

// Dynamically import PDFViewer to avoid SSR issues - memoize to prevent re-imports
const PDFViewer = dynamic(() => import('./PDFViewer'), { 
  ssr: false,
  loading: () => <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center"><div className="text-white">Loading PDF viewer...</div></div>
})

export default function BeaconRealtimeVoice({ selectedPdf, autoStart }) {
  const [state, setState] = useState('idle')
  const [status, setStatus] = useState('Click Start to begin')
  const [transcript, setTranscript] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  const [lastSearchResults, setLastSearchResults] = useState([])
  
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

  // Initialize PDF URL once when PDF is selected
  useEffect(() => {
    const initializePdfUrl = async () => {
      if (selectedPdf) {
        try {
          const filePath = selectedPdf.storage_path || `pdfs/${selectedPdf.file_name}`
          const { data } = await supabase.storage
            .from('pdfs')
            .getPublicUrl(filePath.replace('pdfs/', ''))
          
          if (data && data.publicUrl) {
            setPdfUrl(data.publicUrl)
            console.log('PDF URL initialized:', data.publicUrl)
          }
        } catch (error) {
          console.error('Error getting PDF URL:', error)
        }
      }
    }
    
    initializePdfUrl()
  }, [selectedPdf])

  // Get PDF context for the AI
  const getPdfContext = async () => {
    if (!selectedPdf) return '';
    
    try {
      // Get first few pages of content
      const { data } = await supabase
        .from('pdf_pages')
        .select('page_number, text_content')
        .eq('pdf_id', selectedPdf.id)
        .order('page_number')
        .limit(3)
      
      if (data && data.length > 0) {
        return data.map(p => 
          `Page ${p.page_number}: ${p.text_content.substring(0, 500)}...`
        ).join('\n\n')
      }
    } catch (error) {
      console.error('Error getting PDF context:', error)
    }
    return ''
  }

  // Get page offset from database
  const getPageOffset = () => {
    // Use the content_starts_at field from the PDF record
    // If content starts at page 3, we need offset of -2 (to go from page 3 to page 1)
    if (selectedPdf && selectedPdf.content_starts_at) {
      return -(selectedPdf.content_starts_at - 1)
    }
    return 0
  }
  
  // Handle showing a specific page with proper offset
  const handleShowPage = (pageNumber) => {
    const offset = getPageOffset()
    // For viewing, we DON'T apply the offset - we want the raw database page
    // The database page 37 IS the physical page 37 in the PDF
    const actualPageNumber = pageNumber  // No offset for viewing!
    
    console.log(`Showing database/physical page ${actualPageNumber} (AI called it page ${pageNumber + offset})`)
    console.log('PDF Viewer state - isOpen:', isPdfViewerOpen, 'URL:', pdfUrl)
    
    // Update the page number and ensure viewer is open
    setCurrentPageNumber(actualPageNumber)
    if (!isPdfViewerOpen) {
      console.log('Opening PDF viewer')
      setIsPdfViewerOpen(true)
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
        setStatus('Connected! Start talking about your PDF')
        
        // Get PDF context
        const pdfContext = await getPdfContext()
        
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
            instructions: `You are Beacon, an AI assistant helping search and understand PDFs.
            
            ${selectedPdf ? `The user has loaded a PDF: "${selectedPdf.original_name}"` : ''}
            ${pdfContext ? `\nHere's some content from the PDF:\n${pdfContext}` : ''}
            
            When users ask questions:
            - Use the search_pdf function to find specific information
            - Use the show_page function when users ask to see a specific page
            - Be conversational and natural
            - Reference page numbers from search results
            - If search returns nothing, suggest different search terms
            - Keep responses concise for voice conversation
            
            Examples of when to use show_page:
            - "Show me page 35"
            - "Can I see page 10?"
            - "Display page 42"
            - "Go to page 15"
            
            After searching, you can also offer to show pages: "I found it on page 35. Would you like me to display it?"`,
            tools: [
              {
                type: "function",
                name: "search_pdf",
                description: "Search the PDF for specific keywords or phrases",
                parameters: {
                  type: "object",
                  properties: {
                    query: {
                      type: "string",
                      description: "The search term or phrase to look for in the PDF"
                    }
                  },
                  required: ["query"]
                }
              },
              {
                type: "function", 
                name: "show_page",
                description: "Display a specific page of the PDF",
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
          
          if (msg.name === 'search_pdf') {
            try {
              const args = JSON.parse(msg.arguments)
              const searchQuery = args.query
              
              console.log('Searching PDF for:', searchQuery)
              setStatus(`Searching for: ${searchQuery}`)
              
              // Search the PDF
              const { data: searchResults, error } = await supabase
                .from('pdf_pages')
                .select('page_number, text_content')
                .eq('pdf_id', selectedPdf.id)
                .ilike('text_content', `%${searchQuery}%`)
                .limit(3)
              
              if (error) throw error
              
              // Store search results for display
              if (searchResults && searchResults.length > 0) {
                setLastSearchResults(searchResults)
                // Auto-show the first result
                setTimeout(() => {
                  handleShowPage(searchResults[0].page_number)
                }, 500)
              }
              
              // Format results for the AI with offset correction
              let resultText = ''
              const offset = getPageOffset()
              
              if (searchResults && searchResults.length > 0) {
                resultText = searchResults.map(result => {
                  const actualPageNum = result.page_number + offset
                  return `Page ${actualPageNum}: ...${
                    result.text_content.substring(
                      Math.max(0, result.text_content.toLowerCase().indexOf(searchQuery.toLowerCase()) - 100),
                      Math.min(result.text_content.length, result.text_content.toLowerCase().indexOf(searchQuery.toLowerCase()) + 200)
                    )
                  }...`
                }).join('\n\n')
              } else {
                resultText = `No results found for "${searchQuery}"`
              }
              
              console.log('Search results with corrected page numbers:', resultText)
              
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
              
              // Apply offset to get the correct database page
              const offset = getPageOffset()
              const dbPageNumber = pageNumber - offset  // Convert from spoken page to DB page
              
              // Show the page
              handleShowPage(dbPageNumber)
              
              // Send confirmation back to AI
              const functionOutput = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: msg.call_id,
                  output: `Displaying page ${pageNumber} now`
                }
              }
              
              dc.send(JSON.stringify(functionOutput))
              
              // Tell AI to respond
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
          console.error('Realtime error:', msg.error)
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
      
      // Send offer to our API (same as your tutor)
      const response = await fetch('/api/realtime/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          sdp: pc.localDescription.sdp,
          pdfContext: selectedPdf?.original_name || null
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
              const offset = getPageOffset()
              const displayPageNum = result.page_number + offset
              return (
                <button
                  key={idx}
                  onClick={() => handleShowPage(result.page_number)}
                  className="px-3 py-1 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 text-sm font-medium transition"
                >
                  📄 Page {displayPageNum}
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
          />
        </div>
      )}
    </div>
  )
}