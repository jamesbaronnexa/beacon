'use client'
import { useState, useEffect } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'

// Set up the worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.js`

export default function PDFViewer({ url, pageNumber, onClose }) {
  const [numPages, setNumPages] = useState(null)
  const [currentPage, setCurrentPage] = useState(pageNumber || 1)
  const [scale, setScale] = useState(1.0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Update page when prop changes
  useEffect(() => {
    if (pageNumber) {
      setCurrentPage(pageNumber)
    }
  }, [pageNumber])

  function onDocumentLoadSuccess({ numPages }) {
    setNumPages(numPages)
    setLoading(false)
    // Jump to requested page after load
    if (pageNumber && pageNumber <= numPages) {
      setCurrentPage(pageNumber)
    }
  }

  function onDocumentLoadError(error) {
    console.error('PDF load error:', error)
    setError(error.message)
    setLoading(false)
  }

  const goToPrevPage = () => {
    setCurrentPage(prev => Math.max(1, prev - 1))
  }

  const goToNextPage = () => {
    setCurrentPage(prev => Math.min(numPages, prev + 1))
  }

  const zoomIn = () => {
    setScale(prev => Math.min(3, prev + 0.2))
  }

  const zoomOut = () => {
    setScale(prev => Math.max(0.5, prev - 0.2))
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
        {loading && (
          <div className="text-white text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
            Loading PDF...
          </div>
        )}
        
        {error && (
          <div className="text-red-400 text-center p-4">
            <p>Error loading PDF</p>
            <p className="text-sm mt-2">{error}</p>
          </div>
        )}

        <Document
          file={url}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={onDocumentLoadError}
          loading=""
        >
          <Page
            pageNumber={currentPage}
            width={pageWidth}
            scale={scale}
            renderAnnotationLayer={false}
            renderTextLayer={false}
            className="shadow-2xl"
          />
        </Document>
      </div>

      {/* Navigation */}
      {numPages > 1 && (
        <div className="bg-gray-900 text-white p-3 flex justify-center items-center gap-4">
          <button
            onClick={goToPrevPage}
            disabled={currentPage <= 1}
            className="px-4 py-2 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
          >
            ← Previous
          </button>
          
          <input
            type="number"
            min="1"
            max={numPages}
            value={currentPage}
            onChange={(e) => {
              const page = parseInt(e.target.value)
              if (page >= 1 && page <= numPages) {
                setCurrentPage(page)
              }
            }}
            className="w-16 px-2 py-1 bg-gray-700 rounded text-center"
          />
          
          <button
            onClick={goToNextPage}
            disabled={currentPage >= numPages}
            className="px-4 py-2 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}