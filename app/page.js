'use client'
import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Home() {
  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [status, setStatus] = useState('')
  const [extractedText, setExtractedText] = useState('')
  const [pdfData, setPdfData] = useState(null)
  const [dragActive, setDragActive] = useState(false)

  const handleDrag = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true)
    } else if (e.type === "dragleave") {
      setDragActive(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0]
      if (droppedFile.type === 'application/pdf') {
        setFile(droppedFile)
      } else {
        setStatus('Please upload a PDF file')
      }
    }
  }

  const handleUpload = async () => {
    if (!file) return
    
    setUploading(true)
    setStatus('Uploading PDF...')
    
    try {
      // Upload to Supabase Storage
      const fileName = `${Date.now()}-${file.name}`
      const { data, error } = await supabase.storage
        .from('pdfs')
        .upload(fileName, file)
      
      if (error) throw error
      
      setStatus('Upload successful! Extracting text...')
      
      // Extract text via API
      const extractResponse = await fetch('/api/extract-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          fileName,
          originalName: file.name 
        })
      })

      if (!extractResponse.ok) {
        const errorData = await extractResponse.json()
        throw new Error(errorData.error || 'Failed to extract text')
      }

      const extractData = await extractResponse.json()
      setPdfData(extractData)
      setExtractedText(extractData.fullText)
      setStatus(`Success! Extracted ${extractData.pages} pages`)
      
      // Auto-redirect to search after successful upload
      setTimeout(() => {
        window.location.href = '/search'
      }, 2000)
      
    } catch (error) {
      console.error('Error:', error)
      setStatus('Error: ' + error.message)
    }
    
    setUploading(false)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 relative overflow-hidden">
      {/* Animated background */}
      <div className="absolute inset-0 opacity-20">
        <div className="absolute top-0 -left-4 w-96 h-96 bg-blue-500 rounded-full mix-blend-multiply filter blur-3xl animate-blob"></div>
        <div className="absolute top-0 -right-4 w-96 h-96 bg-amber-500 rounded-full mix-blend-multiply filter blur-3xl animate-blob animation-delay-2000"></div>
        <div className="absolute -bottom-8 left-20 w-96 h-96 bg-cyan-500 rounded-full mix-blend-multiply filter blur-3xl animate-blob animation-delay-4000"></div>
      </div>

      <div className="relative z-10 p-8 max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12 mt-12">
          <div className="inline-block">
            <div className="flex items-center justify-center mb-4">
              <div className="w-20 h-20 bg-gradient-to-br from-amber-400 to-orange-500 rounded-full flex items-center justify-center shadow-2xl">
                <svg className="w-10 h-10 text-amber-900" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              </div>
            </div>
            <h1 className="text-5xl font-bold text-white mb-4 bg-gradient-to-r from-amber-400 to-orange-500 bg-clip-text text-transparent">
              Beacon
            </h1>
            <p className="text-xl text-blue-200">Upload your documents, search with voice</p>
          </div>
        </div>
        
        {/* Upload Area */}
        <div 
          className={`
            relative rounded-2xl p-12 transition-all duration-300
            ${dragActive 
              ? 'bg-amber-500/20 border-amber-400 scale-105' 
              : 'bg-white/10 border-white/20 hover:bg-white/15'
            }
            backdrop-blur-lg border-2 border-dashed
          `}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
        >
          <div className="text-center">
            <svg className="mx-auto h-16 w-16 text-blue-200 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            
            <p className="text-xl text-white mb-2">
              {file ? file.name : 'Drop your PDF here'}
            </p>
            
            <p className="text-blue-200 mb-6">or</p>
            
            <label className="inline-block">
              <input
                type="file"
                accept=".pdf"
                onChange={(e) => setFile(e.target.files[0])}
                className="hidden"
              />
              <span className="px-6 py-3 bg-white/20 text-white rounded-xl hover:bg-white/30 transition-all cursor-pointer border border-white/30">
                Choose PDF
              </span>
            </label>
            
            {file && (
              <div className="mt-6 space-y-4">
                <div className="bg-white/10 rounded-lg p-4 text-left">
                  <p className="text-blue-200 text-sm mb-1">Selected file:</p>
                  <p className="text-white font-medium">{file.name}</p>
                  <p className="text-blue-300 text-sm mt-1">
                    {(file.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
                
                <button
                  onClick={handleUpload}
                  disabled={!file || uploading}
                  className={`
                    w-full py-4 rounded-xl font-semibold transition-all transform
                    ${uploading 
                      ? 'bg-amber-500/50 text-white/50 scale-95' 
                      : 'bg-gradient-to-r from-amber-400 to-orange-500 text-white hover:scale-105 shadow-xl'
                    }
                  `}
                >
                  {uploading ? 'Processing...' : 'Upload & Process'}
                </button>
              </div>
            )}
            
            {status && (
              <div className={`
                mt-6 p-4 rounded-xl
                ${status.includes('Error') 
                  ? 'bg-red-500/20 text-red-200 border border-red-500/30' 
                  : status.includes('Success')
                  ? 'bg-green-500/20 text-green-200 border border-green-500/30'
                  : 'bg-blue-500/20 text-blue-200 border border-blue-500/30'
                }
              `}>
                {status}
              </div>
            )}
          </div>
        </div>
        
        {/* Features */}
        <div className="grid grid-cols-3 gap-6 mt-12">
          <div className="text-center">
            <div className="w-12 h-12 bg-gradient-to-br from-amber-400/20 to-orange-500/20 rounded-full flex items-center justify-center mx-auto mb-3 border border-amber-400/30">
              <svg className="w-6 h-6 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
              </svg>
            </div>
            <h3 className="text-white font-semibold mb-1">Upload PDFs</h3>
            <p className="text-blue-200 text-sm">Any size, any content</p>
          </div>
          
          <div className="text-center">
            <div className="w-12 h-12 bg-gradient-to-br from-amber-400/20 to-orange-500/20 rounded-full flex items-center justify-center mx-auto mb-3 border border-amber-400/30">
              <svg className="w-6 h-6 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <h3 className="text-white font-semibold mb-1">Voice Search</h3>
            <p className="text-blue-200 text-sm">Natural conversation</p>
          </div>
          
          <div className="text-center">
            <div className="w-12 h-12 bg-gradient-to-br from-amber-400/20 to-orange-500/20 rounded-full flex items-center justify-center mx-auto mb-3 border border-amber-400/30">
              <svg className="w-6 h-6 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-white font-semibold mb-1">Instant Results</h3>
            <p className="text-blue-200 text-sm">See the exact page</p>
          </div>
        </div>
        
        {/* Quick link to search */}
        <div className="text-center mt-12">
          <a 
            href="/search"
            className="inline-flex items-center gap-2 text-blue-200 hover:text-amber-400 transition-colors"
          >
            Already uploaded? Go to search
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </a>
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