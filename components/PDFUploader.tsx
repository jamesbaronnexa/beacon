'use client';

import { useState } from 'react';

export default function PDFUploader() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const handleUpload = async () => {
    if (!file) return;

    setLoading(true);
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/analyze-layout', {
      method: 'POST',
      body: formData,
    });

    const json = await res.json();
    setLoading(false);

    if (!res.ok) {
      console.error('❌ Azure error:', json.error);
      alert('Failed to analyze PDF: ' + json.error);
    } else {
      console.log('✅ Azure layout result:', json.result);
      setResult(json.result.analyzeResult); // layout data only
    }
  };

  return (
    <div className="max-w-xl p-4 border rounded">
      <h2 className="text-lg font-bold mb-2">Upload PDF for Azure Layout Analysis</h2>

      <input
        type="file"
        accept="application/pdf"
        onChange={(e) => setFile(e.target.files?.[0] || null)}
        className="mb-2"
      />

      <button
        onClick={handleUpload}
        disabled={!file || loading}
        className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
      >
        {loading ? 'Analyzing…' : 'Analyze PDF'}
      </button>

      {result && (
        <pre className="mt-4 max-h-96 overflow-auto bg-gray-100 p-2 text-sm">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
