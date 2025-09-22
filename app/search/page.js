'use client'
import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '../../lib/supabase'
import BeaconRealtimeVoice from '../../components/BeaconRealtimeVoice'

function SearchContent() {
  const searchParams = useSearchParams()
  const category = searchParams.get('category') || searchParams.get('c')
  const pdfIds = searchParams.get('pdfs')
  
  const [pdfs, setPdfs] = useState([])
  const [selectedPdf, setSelectedPdf] = useState(null)
  const [loading, setLoading] = useState(true)
  const [isListening, setIsListening] = useState(false)
  const [showPdfViewer, setShowPdfViewer] = useState(false)
  const [sessionStarted, setSessionStarted] = useState(false)
  const [isMobile, setIsMobile] = useState(false)

  // Detect mobile device
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768)
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  // Load PDFs on mount
  useEffect(() => {
    loadPdfs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, pdfIds])

  const loadPdfs = async () => {
    try {
      let query = supabase
        .from('pdfs')
        .select('*')
        .order('created_at', { ascending: false })
      
      // Filter by category if specified
      if (category) {
        query = query.eq('category', category)
      } else if (pdfIds) {
        // Or filter by specific IDs
        const idArray = pdfIds.split(',')
        query = query.in('id', idArray)
      }
      
      const { data, error } = await query
      
      if (error) throw error
      
      setPdfs(data || [])
      if (data && data.length > 0) {
        setSelectedPdf(data[0])
      }
    } catch (error) {
      console.error('Error loading PDFs:', error)
    } finally {
      setLoading(false)
    }
  }

  // Get display name for category
  const getCategoryTitle = () => {
    if (category === 'electrical') return 'Electrical Regulations'
    if (category === 'solar') return 'Solar Installation Codes'
    if (category === 'plumbing') return 'Plumbing Standards'
    if (category === 'hvac') return 'HVAC Requirements'
    if (category === 'building') return 'Building Codes'
    if (category === 'safety') return 'Safety Standards'
    return 'Beacon'
  }

  const getCategoryDescription = () => {
    if (category) {
      return `${pdfs.length} ${pdfs.length === 1 ? 'document' : 'documents'} available`
    }
    return 'Your guide through documents'
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 flex items-center justify-center">
        <div className="text-white text-xl animate-pulse">Loading...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 relative overflow-hidden">
      {/* Animated background waves */}
      <div className="absolute inset-0 opacity-20">
        <div className="absolute top-0 -left-4 w-96 h-96 bg-blue-500 rounded-full mix-blend-multiply filter blur-3xl animate-blob"></div>
        <div className="absolute top-0 -right-4 w-96 h-96 bg-amber-500 rounded-full mix-blend-multiply filter blur-3xl animate-blob animation-delay-2000"></div>
        <div className="absolute -bottom-8 left-20 w-96 h-96 bg-cyan-500 rounded-full mix-blend-multiply filter blur-3xl animate-blob animation-delay-4000"></div>
      </div>

      {/* Header */}
      <div className="relative z-10 p-4 sm:p-6">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white mb-1 sm:mb-2">
              {getCategoryTitle()}
            </h1>
            <p className="text-blue-200 text-sm sm:text-base">
              {getCategoryDescription()}
            </p>
          </div>
          
          {/* PDF Selector - only show if multiple PDFs */}
          {pdfs.length > 1 && (
            <div className="w-full sm:w-auto bg-white/10 backdrop-blur-lg rounded-xl p-3 sm:p-4 border border-white/20">
              <label className="block text-xs sm:text-sm text-blue-200 mb-1 sm:mb-2">
                {category ? 'Select Document' : 'Active Document'}
              </label>
              <select 
                className="w-full bg-white/10 text-white rounded-lg px-3 py-2 sm:px-4 sm:py-2 border border-white/20 focus:border-amber-400 focus:outline-none transition-colors text-sm sm:text-base"
                value={selectedPdf?.id || ''}
                onChange={(e) => {
                  const pdf = pdfs.find(p => p.id === e.target.value)
                  setSelectedPdf(pdf)
                }}
              >
                {pdfs.length === 0 ? (
                  <option>No documents available</option>
                ) : (
                  pdfs.map(pdf => (
                    <option key={pdf.id} value={pdf.id}>
                      {pdf.original_name}
                    </option>
                  ))
                )}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Main Beacon Interface */}
      <div className="relative z-10 flex flex-col items-center justify-center min-h-[60vh] sm:min-h-[70vh] px-4">
        {!isListening ? (
          <div className="relative group cursor-pointer" onClick={() => {
            if (pdfs.length === 0) {
              alert('No documents available in this category')
              return
            }
            setIsListening(true)
            setSessionStarted(true)
          }}>
            {/* Beacon glow effect */}
            <div className="absolute inset-0 bg-gradient-to-r from-amber-400 to-orange-500 rounded-full blur-3xl opacity-40 group-hover:opacity-60 transition-opacity animate-pulse"></div>
            
            {/* Beacon icon - smaller on mobile */}
            <div className="relative w-36 h-36 sm:w-48 sm:h-48 bg-gradient-to-br from-amber-400 to-orange-500 rounded-full flex items-center justify-center transform transition-all duration-300 group-hover:scale-110 shadow-2xl">
              <div className="w-30 h-30 sm:w-40 sm:h-40 bg-gradient-to-br from-amber-300 to-orange-400 rounded-full flex items-center justify-center">
                <div className="w-24 h-24 sm:w-32 sm:h-32 bg-gradient-to-br from-amber-200 to-orange-300 rounded-full flex flex-col items-center justify-center">
                  <svg className="w-12 h-12 sm:w-16 sm:h-16 text-amber-900" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                  <span className="text-amber-900 font-bold text-sm sm:text-lg mt-1 sm:mt-2">BEACON</span>
                </div>
              </div>
            </div>
            
            <p className="text-white/80 text-center mt-4 sm:mt-6 text-base sm:text-lg">
              {pdfs.length === 0 ? 
                'No documents in this category' : 
                `${isMobile ? 'Tap' : 'Click'} to start voice search`
              }
            </p>
          </div>
        ) : (
          <div className="w-full max-w-2xl px-4 sm:px-6">
            {/* Embedded Realtime Voice Component with auto-start */}
            <BeaconRealtimeVoice 
              selectedPdf={selectedPdf}
              allPdfs={pdfs}
              category={category}
              onPdfDisplay={() => setShowPdfViewer(true)}
              autoStart={sessionStarted}
            />
            
            <button
              onClick={() => {
                setIsListening(false)
                setSessionStarted(false)
              }}
              className="mt-4 px-4 py-2 bg-white/10 backdrop-blur text-white rounded-lg hover:bg-white/20 transition-colors mx-auto block"
            >
              Back to Beacon
            </button>
          </div>
        )}
      </div>

      {/* Quick Actions - Conditional upload button */}
      <div className="fixed sm:absolute bottom-4 sm:bottom-6 left-4 sm:left-6 right-4 sm:right-6 z-10">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          {/* Only show upload button when not in listening mode */}
          {!isListening && !category && (
            <Link 
              href="/"
              className="px-4 sm:px-6 py-2 sm:py-3 bg-white/10 backdrop-blur-lg text-white rounded-xl hover:bg-white/20 transition-all border border-white/20 text-sm sm:text-base"
            >
              ← Upload Documents
            </Link>
          )}
          
          {selectedPdf && (
            <div className={`text-white/60 text-xs sm:text-sm ${!isListening && !category ? '' : 'ml-0'}`}>
              {selectedPdf.total_pages} pages • {Math.round(selectedPdf.total_characters / 1000)}k characters
              {category && ` • ${category.toUpperCase()}`}
            </div>
          )}
        </div>
      </div>

      <style jsx>{`
        @keyframes blob {
          0% {
            transform: translate(0px, 0px) scale(1);
          }
          33% {
            transform: translate(30px, -50px) scale(1.1);
          }
          66% {
            transform: translate(-20px, 20px) scale(0.9);
          }
          100% {
            transform: translate(0px, 0px) scale(1);
          }
        }
        .animate-blob {
          animation: blob 7s infinite;
        }
        .animation-delay-2000 {
          animation-delay: 2s;
        }
        .animation-delay-4000 {
          animation-delay: 4s;
        }
      `}</style>
    </div>
  )
}

export default function Search() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 flex items-center justify-center">
        <div className="text-white text-xl animate-pulse">Loading...</div>
      </div>
    }>
      <SearchContent />
    </Suspense>
  )
}