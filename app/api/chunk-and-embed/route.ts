import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

export const runtime = 'nodejs';
export const maxDuration = 300;

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase envs');
  return createClient(url, key, { auth: { persistSession: false } });
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

type PageRow = {
  id: string;
  pdf_page_number: number;
  content: string | null;
  section_number: string | null;
  section_title: string | null;
};

function stripNoise(text: string) {
  const lines = (text || '').split(/\r?\n/);
  const drop = [
    /Electrical Workers Licensing Group/i,
    /temporarily download this document/i,
    /auto login/i,
    /^\s*\d+\s*$/,        // lone page numerals
  ];
  return lines.filter(l => !drop.some(r => r.test(l))).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function splitIntoParagraphs(text: string) {
  return text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
}

function approxTokens(s: string) { return Math.ceil((s || '').length / 4); }

function makeChunks(
  text: string,
  { targetTokens = 900, overlapChars = 280 }: { targetTokens?: number; overlapChars?: number } = {}
) {
  const paras = splitIntoParagraphs(text);
  const out: Array<{ content: string; start: number; end: number; token_count: number }> = [];
  let buf = '';
  let cursor = 0;

  const HEADING_RE = /^\s*(?:Part\s+\d+[:\-–]\s+|(?:\d+\.)*\d+)\s+[\w(].*/i;

  for (const p of paras) {
    const isHeading = HEADING_RE.test(p);
    const next = buf ? buf + '\n\n' + p : p;
    if ((approxTokens(next) > targetTokens && buf) || (isHeading && buf)) {
      const start = cursor;
      const end = start + buf.length;
      out.push({ content: buf, start, end, token_count: approxTokens(buf) });
      const tail = buf.slice(Math.max(0, buf.length - overlapChars));
      cursor = end - tail.length - 2;
      buf = tail + '\n\n' + p;
    } else {
      buf = next;
    }
  }
  if (buf.trim()) {
    const start = cursor;
    const end = start + buf.length;
    out.push({ content: buf, start, end, token_count: approxTokens(buf) });
  }
  return out;
}

async function embedBatch(texts: string[], model = 'text-embedding-3-small') {
  if (!texts.length) return [];
  const res = await openai.embeddings.create({ model, input: texts });
  return res.data.map(d => d.embedding);
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getAdminClient();
    const body = (await req.json().catch(() => ({}))) as {
      documentId: string;
      model?: 'text-embedding-3-small' | 'text-embedding-3-large';
      targetTokens?: number;
      overlapChars?: number;
      append?: boolean;      // if false, wipe existing chunks first
      limitPages?: number;
    };

    const {
      documentId,
      model = 'text-embedding-3-small',
      targetTokens = 900,
      overlapChars = 280,
      append = false,
      limitPages,
    } = body;

    if (!documentId) return NextResponse.json({ error: 'documentId required' }, { status: 400 });

    // get content pages
    const { data: pages, error: pErr } = await supabase
      .from('pages')
      .select('id,pdf_page_number,content,section_number,section_title')
      .eq('document_id', documentId)
      .eq('page_type', 'content')
      .order('pdf_page_number', { ascending: true });
    if (pErr) throw pErr;
    if (!pages?.length) return NextResponse.json({ error: 'No content pages found' }, { status: 404 });

    const work: PageRow[] = limitPages ? pages.slice(0, limitPages) : pages;

    // idempotent behavior
    if (!append) {
      const { error: delErr } = await supabase.from('chunks').delete().eq('document_id', documentId);
      if (delErr) throw delErr;
    }

    // build chunks
    const all = [];
    for (const page of work) {
      const txt = stripNoise(page.content || '');
      if (!txt) continue;
      const parts = makeChunks(txt, { targetTokens, overlapChars });
      parts.forEach((c, i) => all.push({ page, idx: i, ...c }));
    }

    // embed + insert in batches
    const BATCH = 64;
    let inserted = 0;
    for (let i = 0; i < all.length; i += BATCH) {
      const batch = all.slice(i, i + BATCH);
      const embs = await embedBatch(batch.map(b => b.content), model);
      const rows = batch.map((b, j) => ({
        document_id: documentId,
        page_id: b.page.id,
        pdf_page_number: b.page.pdf_page_number,
        section_number: b.page.section_number,
        section_title: b.page.section_title,
        chunk_index: b.idx,
        start_char: b.start,
        end_char: b.end,
        token_count: b.token_count,
        content: b.content,
        embedding: embs[j] as unknown as number[],
      }));
      const { error: insErr } = await supabase.from('chunks').insert(rows);
      if (insErr) throw insErr;
      inserted += rows.length;
    }

    return NextResponse.json({
      success: true,
      documentId,
      model,
      pagesConsidered: work.length,
      chunksCreated: inserted,
      targetTokens,
      overlapChars,
      append,
    });
  } catch (err: any) {
    console.error('chunk-and-embed error:', err?.message || err);
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
}
