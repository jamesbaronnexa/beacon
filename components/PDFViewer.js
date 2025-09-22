'use client'
import { useState, useEffect, useRef } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'

// Set up the worker - using working CDN URL for version 5.x
pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.mjs`

export default function PDFViewer({ url, pageNumber, onClose }) {
  const [numPages, setNumPages] = useState(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale] = useState(1.0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [pdfUrl, setPdfUrl] = useState(url)
  const [documentLoaded, setDocumentLoaded] = useState(false)
  const documentRef = useRef(null)
  const [key, setKey] = useState(0) // Add key for force reload if needed

  // Debug logging - only log once
  useEffect(() => {
    console.log('PDFViewer mounted with URL:', url)
    console.log('Initial page request:', pageNumber)
    // Prevent document from reloading on page changes
  const memoizedOptions = useMemo(() => ({
    cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjs.version}/cmaps/`,
    cMapPacked: true,
  }), [])

  // Get window dimensions for mobile responsiveness) => {
      console.log('PDFViewer unmounting')
    }
  }, [])

  // Log page changes
  useEffect(() => {
    if (documentLoaded) {
      console.log('Page navigation:', pageNumber)
    }
  }, [pageNumber, documentLoaded])

  // Handle URL changes
  useEffect(() => {
    if (url && !url.startsWith('http')) {
      const fullUrl = window.location.origin + url
      setPdfUrl(fullUrl)
    } else {
      setPdfUrl(url)
    }
  }, [url])

  // Handle page number updates with debouncing to prevent rapid changes
  // Only update from props if it's different from current page
  useEffect(() => {
    if (documentLoaded && pageNumber && pageNumber > 0 && pageNumber !== currentPage) {
      // Add a small delay to prevent rapid page changes from breaking the PDF
      const timeoutId = setTimeout(() => {
        // Ensure page number is within bounds
        const targetPage = Math.min(Math.max(1, pageNumber), numPages || pageNumber)
        console.log(`External navigation to page ${targetPage} (requested: ${pageNumber}, current: ${currentPage})`)
        setCurrentPage(targetPage)
      }, 100) // 100ms delay to prevent rapid changes
      
      return () => clearTimeout(timeoutId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNumber, documentLoaded]) // Intentionally omitting currentPage and numPages to prevent loops

  function onDocumentLoadSuccess(pdf) {
    console.log('PDF loaded successfully, pages:', pdf.numPages)
    setNumPages(pdf.numPages)
    setLoading(false)
    setDocumentLoaded(true)
    documentRef.current = pdf
    
    // Set initial page after load
    if (pageNumber && pageNumber > 0 && pageNumber <= pdf.numPages) {
      console.log('Setting initial page to:', pageNumber)
      setCurrentPage(pageNumber)
    } else {
      // Default to page 1 if no valid page number provided
      setCurrentPage(1)
    }
  }

  function onDocumentLoadError(error) {
    console.error('PDF load error:', error)
    setError(error?.message || 'Failed to load PDF')
    setLoading(false)
    setDocumentLoaded(false)
  }

  const goToPrevPage = () => {
    const newPage = Math.max(1, currentPage - 1)
    console.log('Previous page clicked, going to:', newPage)
    setCurrentPage(newPage)
  }

  const goToNextPage = () => {
    const newPage = Math.min(numPages || 1, currentPage + 1)
    console.log('Next page clicked, going to:', newPage)
    setCurrentPage(newPage)
  }

  const zoomIn = () => {
    setScale(prev => Math.min(3, prev + 0.2))
  }

  const zoomOut = () => {
    setScale(prev => Math.max(0.5, prev - 0.2))
  }

  const handlePageInputChange = (e) => {
    const page = parseInt(e.target.value)
    if (!isNaN(page) && page >= 1 && page <= (numPages || 1)) {
      console.log('Manual page input:', page)
      setCurrentPage(page)
    }
  }

  // Get window dimensions for mobile responsiveness
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 800
  )

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Calculate page width for mobile
  const pageWidth = Math.min(windowWidth - 40, 800)

  return (
    <div className="fixed inset-0 bg-black bg-opacity-90 z-50 flex flex-col">
      {/* Header */}
      <div className="bg-gray-900 text-white p-3 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            Page {currentPage} of {numPages || '...'}
          </span>
        </div>
        
        {/* Controls */}
        <div className="flex items-center gap-2">
          {/* Zoom controls */}
          <button
            onClick={zoomOut}
            className="p-2 bg-gray-700 rounded hover:bg-gray-600"
            title="Zoom Out"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
          <span className="text-xs w-12 text-center">{Math.round(scale * 100)}%</span>
          <button
            onClick={zoomIn}
            className="p-2 bg-gray-700 rounded hover:bg-gray-600"
            title="Zoom In"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
          
          {/* Close button */}
          <button
            onClick={onClose}
            className="ml-2 px-3 py-1 bg-red-600 text-white rounded hover:bg-red-700"
          >
            Close
          </button>
        </div>
      </div>

      {/* PDF Document */}
      <div className="flex-1 overflow-auto bg-gray-800 flex justify-center items-start p-4">
        {loading && !documentLoaded && (
          <div className="text-white text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
            Loading PDF...
          </div>
        )}
        
        {error && (
          <div className="text-red-400 text-center p-4">
            <p>Error loading PDF</p>
            <p className="text-sm mt-2">{error}</p>
            <p className="text-xs mt-2 opacity-75">URL: {pdfUrl}</p>
          </div>
        )}

        {!error && (
          <Document
            file={pdfUrl}
            onLoadSuccess={onDocumentLoadSuccess}
            onLoadError={onDocumentLoadError}
            loading={null}
            options={memoizedOptions}
          >
            {documentLoaded && (
              <Page
                key={`${pdfUrl}-${currentPage}`} // Unique key per page
                pageNumber={currentPage}
                width={pageWidth}
                scale={scale}
                renderAnnotationLayer={false}
                renderTextLayer={false}
                className="shadow-2xl"
                loading={
                  <div className="text-white text-center p-4">
                    Loading page {currentPage}...
                  </div>
                }
                error={
                  <div className="text-red-400 text-center p-4">
                    Error loading page {currentPage}
                  </div>
                }
              />
            )}
          </Document>
        )}
      </div>

      {/* Navigation */}
      {numPages && numPages > 1 && (
        <div className="bg-gray-900 text-white p-3 flex justify-center items-center gap-2 sm:gap-4">
          <button
            onClick={goToPrevPage}
            disabled={currentPage <= 1}
            className="px-3 py-2 sm:px-4 sm:py-2 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600 disabled:cursor-not-allowed active:bg-gray-800 transition-colors"
          >
            ← Prev
          </button>
          
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              max={numPages}
              value={currentPage}
              onChange={handlePageInputChange}
              className="w-14 sm:w-16 px-2 py-1 bg-gray-700 rounded text-center text-sm sm:text-base"
            />
            <span className="text-xs sm:text-sm text-gray-400">/ {numPages}</span>
          </div>
          
          <button
            onClick={goToNextPage}
            disabled={currentPage >= numPages}
            className="px-3 py-2 sm:px-4 sm:py-2 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600 disabled:cursor-not-allowed active:bg-gray-800 transition-colors"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}