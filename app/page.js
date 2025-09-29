'use client';

import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnon);

export default function Home() {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);

  const [apiResult, setApiResult] = useState(null);      // server response { success, documentId, ... }
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [pageCount, setPageCount] = useState(null);
  const [docRow, setDocRow] = useState(null);
  const [error, setError] = useState(null);

  // GPT labeling UI state
  const [labelLoading, setLabelLoading] = useState(false);
  const [labelStats, setLabelStats] = useState(null);
  const [labelChanges, setLabelChanges] = useState([]);

  const [chunkLoading, setChunkLoading] = useState(false);
  const [chunkStats, setChunkStats] = useState(null);


  const handleUpload = async () => {
    setError(null);
    setApiResult(null);
    setPageCount(null);
    setDocRow(null);
    setLabelStats(null);
    setLabelChanges([]);

    if (!file) return;
    setLoading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/analyze-layout', { method: 'POST', body: formData });
      const json = await res.json();
      setLoading(false);

      if (!res.ok) {
        setError(json?.error || 'Upload failed');
        return;
      }

      // Expecting: { success, documentId, totalPages?, presetApplied?, message? }
      setApiResult(json);
      if (json?.documentId) {
        await verifyInSupabase(json.documentId);
      } else {
        setError('Route did not return documentId. Update your API to return { success, documentId, ... }.');
      }
    } catch (e) {
      setLoading(false);
      setError(e.message || String(e));
    }
  };

  const verifyInSupabase = async (documentId) => {
    setVerifyLoading(true);
    setError(null);

    try {
      // 1) page count (head=true gives count without fetching rows)
      const { count, error: countErr } = await supabase
        .from('pages')
        .select('id', { count: 'exact', head: true })
        .eq('document_id', documentId);

      if (countErr) throw countErr;
      setPageCount(typeof count === 'number' ? count : null);

      // 2) fetch the document row for a quick sanity check
      const { data: doc, error: docErr } = await supabase
        .from('documents')
        .select('id,title,filename,total_pages,content_starts_at_page,toc_ends_at_page,status,uploaded_at')
        .eq('id', documentId)
        .single();

      if (docErr) throw docErr;
      setDocRow(doc);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setVerifyLoading(false);
    }
  };

  // Call GPT labeling route; dryRun=true to preview, false to apply
  const runGptLabel = async (dryRun = true) => {
    const docId = apiResult?.documentId;
    if (!docId) return alert('Upload & parse first');
    setLabelLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/label-sections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ⬇️ Confidence gate + control flags
        body: JSON.stringify({
          documentId: docId,
          dryRun,                 // kept for compatibility if your route supports preview
          minConfidence: 0.85,    // gate writes (server should apply only if >= 0.85)
          onlyMissing: true,      // only touch pages missing labels by default
          force: !dryRun          // allow relabel on Apply; false for Preview
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Labeling failed');
      setLabelStats(json.stats || null);
      setLabelChanges(json.changes || []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLabelLoading(false);
    }
  };

  const runChunkAndEmbed = async () => {
  const docId = apiResult?.documentId;
  if (!docId) return alert('Upload & parse first');
  setChunkLoading(true);
  setError(null);
  try {
    const res = await fetch('/api/chunk-and-embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentId: docId,
        model: 'text-embedding-3-small', // or 'text-embedding-3-large' if you switch schema
        targetTokens: 900,
        overlapChars: 280,
        append: false
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || 'Chunking failed');
    setChunkStats(json);
    await verifyInSupabase(docId);
  } catch (e) {
    setError(e.message || String(e));
  } finally {
    setChunkLoading(false);
  }
};


  return (
    <main className="p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Regs — Analyze & Index PDF</h1>

      <div className="mb-4">
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="block"
        />
      </div>

      <button
        onClick={handleUpload}
        disabled={!file || loading}
        className="bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
      >
        {loading ? 'Analyzing…' : 'Analyze PDF'}
      </button>

      {error && (
        <div className="mt-4 text-red-600">
          <b>Error:</b> {error}
        </div>
      )}

      {apiResult && (
        <section className="mt-6 space-y-2">
          <h2 className="text-lg font-semibold">Server Response</h2>
          <div className="text-sm">
            <div><b>Success:</b> {String(apiResult.success)}</div>
            {apiResult.documentId && <div><b>Document ID:</b> {apiResult.documentId}</div>}
            {apiResult.totalPages != null && <div><b>Total Pages (from Azure):</b> {apiResult.totalPages}</div>}
            {apiResult.presetApplied && <div><b>Preset:</b> {apiResult.presetApplied}</div>}
            {apiResult.message && <div><b>Message:</b> {apiResult.message}</div>}
          </div>

          <button
            onClick={() => apiResult?.documentId && verifyInSupabase(apiResult.documentId)}
            disabled={!apiResult?.documentId || verifyLoading}
            className="bg-gray-800 text-white px-3 py-2 rounded disabled:opacity-50"
          >
            {verifyLoading ? 'Checking Supabase…' : 'Re-check Supabase'}
          </button>
        </section>
      )}

      {(pageCount != null || docRow) && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold mb-2">Supabase Verification</h2>

          {docRow && (
            <div className="text-sm mb-2">
              <div><b>Title:</b> {docRow.title}</div>
              <div><b>Filename:</b> {docRow.filename}</div>
              <div><b>Status:</b> {docRow.status}</div>
              <div><b>Total Pages (doc row):</b> {docRow.total_pages}</div>
              <div><b>Content starts at page:</b> {docRow.content_starts_at_page}</div>
              <div><b>TOC ends at page:</b> {docRow.toc_ends_at_page}</div>
              <div><b>Uploaded:</b> {new Date(docRow.uploaded_at).toLocaleString()}</div>
            </div>
          )}

          {pageCount != null && (
            <div className="text-sm">
              <b>Pages inserted:</b> {pageCount}
            </div>
          )}
        </section>
      )}

      {apiResult?.documentId && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold mb-2">GPT Section Labeling</h2>

          <div className="flex gap-2">
            <button
              onClick={() => runGptLabel(true)}
              disabled={labelLoading}
              className="bg-emerald-600 text-white px-3 py-2 rounded disabled:opacity-50"
            >
              {labelLoading ? 'Running…' : 'Preview (dry-run)'}
            </button>
            <button
              onClick={() => runGptLabel(false)}
              disabled={labelLoading}
              className="bg-amber-600 text-white px-3 py-2 rounded disabled:opacity-50"
            >
              {labelLoading ? 'Applying…' : 'Apply Labels'}
            </button>
          </div>

          {labelStats && (
            <p className="text-sm mt-2">
              Considered: {labelStats.considered} · Proposed: {labelStats.proposed_changes} · Applied: {labelStats.applied}
            </p>
          )}

          {!!labelChanges.length && (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-sm border-collapse">
                <thead>
                  <tr>
                    <th className="text-left border-b p-2">Page</th>
                    <th className="text-left border-b p-2">Before</th>
                    <th className="text-left border-b p-2">After</th>
                    <th className="text-left border-b p-2">Conf</th>
                  </tr>
                </thead>
                <tbody>
                  {labelChanges.map((c) => {
                    const changed = (c.after_number !== c.before_number) || (c.after_title !== c.before_title);
                    return (
                      <tr key={c.id} className={changed ? 'bg-yellow-50' : ''}>
                        <td className="p-2">{c.pdf_page_number}</td>
                        <td className="p-2">
                          <div><b>{c.before_number || '—'}</b></div>
                          <div className="opacity-80">{c.before_title || '—'}</div>
                        </td>
                        <td className="p-2">
                          <div><b>{c.after_number || '—'}</b></div>
                          <div>{c.after_title || '—'}</div>
                        </td>
                        <td className="p-2">{(c.confidence ?? 0).toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {apiResult?.documentId && (
  <section className="mt-6">
    <h2 className="text-lg font-semibold mb-2">Chunk & Embed</h2>
    <button
      onClick={runChunkAndEmbed}
      disabled={chunkLoading}
      className="bg-indigo-600 text-white px-3 py-2 rounded disabled:opacity-50"
    >
      {chunkLoading ? 'Chunking…' : 'Chunk & Embed Now'}
    </button>
    {chunkStats && (
      <div className="text-sm mt-2">
        <div><b>Chunks created:</b> {chunkStats.chunksCreated}</div>
        <div><b>Pages considered:</b> {chunkStats.pagesConsidered}</div>
        <div><b>Model:</b> {chunkStats.model}</div>
        <div><b>Target tokens:</b> {chunkStats.targetTokens} · <b>Overlap chars:</b> {chunkStats.overlapChars}</div>
      </div>
    )}
  </section>
)}


      {apiResult && (
        <section className="mt-6">
          <details>
            <summary className="cursor-pointer font-medium">Raw Response JSON</summary>
            <pre className="bg-gray-100 p-3 mt-2 text-sm rounded overflow-auto max-h-80">
              {JSON.stringify(apiResult, null, 2)}
            </pre>
          </details>
        </section>
      )}
    </main>
  );
}
