import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase envs');
  return createClient(url, key, { auth: { persistSession: false } });
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function POST(req: NextRequest) {
  try {
    const supabase = admin();
    const {
      query,
      documentIds = [],
      category,
      searchMode = 'hybrid',    // 'hybrid' uses vector + lightweight rerank
      matchCount = 10,
      threshold = 0.20
    } = await req.json();

    if (!query || !Array.isArray(documentIds) || documentIds.length === 0) {
      return NextResponse.json({ error: 'query and documentIds are required' }, { status: 400 });
    }

    // 0) Fetch content_starts_at_page for optional page offset in your UI
    const { data: docsMeta, error: docsErr } = await supabase
      .from('documents')
      .select('id, content_starts_at_page')
      .in('id', documentIds);
    if (docsErr) throw docsErr;
    const offsetMap = new Map(docsMeta?.map(d => [d.id, d.content_starts_at_page || null]) || []);

    // 1) Embed the query
    const emb = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query.slice(0, 1000),
    });
    const embedding = emb.data[0].embedding;

    // 2) Vector search per document_id, then merge
    const allHits: Array<{
      document_id: string;
      pdf_page_number: number;
      section_number: string | null;
      section_title: string | null;
      content: string;
      similarity: number;
    }> = [];

    for (const docId of documentIds) {
      const { data, error } = await supabase.rpc('match_chunks', {
        doc_id: docId,
        query_embedding: embedding as unknown as number[],
        match_threshold: threshold,
        match_count: matchCount,
      });
      if (error) throw error;

      (data || []).forEach((r: any) => {
        allHits.push({
          document_id: docId,
          pdf_page_number: r.pdf_page_number,
          section_number: r.section_number,
          section_title: r.section_title,
          content: r.content,
          similarity: Number(r.similarity),
        });
      });
    }

    // 3) Merge+sort by similarity
    allHits.sort((a, b) => b.similarity - a.similarity);

    // 4) Optional lightweight rerank (hybrid) across top candidates
    let finalHits = allHits;
    if (searchMode === 'hybrid' && allHits.length > 1) {
      const top = allHits.slice(0, Math.min(12, allHits.length));
      const numbered = top
        .map((h, i) => `#${i + 1} [Doc ${h.document_id} · Page ${h.pdf_page_number}${h.section_number ? ` · ${h.section_number}` : ''}${h.section_title ? ` · ${h.section_title}` : ''}]\n${h.content.slice(0, 700)}`)
        .join('\n\n');

      const prompt = [
        `Query: "${query}"`,
        `Rank these passages by relevance to the query. Return a JSON array of 1-based indices, e.g. [2,1,3].`,
        numbered,
      ].join('\n\n');

      try {
        const rr = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          temperature: 0.0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You re-rank passages by semantic relevance. Output only JSON.' },
            { role: 'user', content: prompt },
          ],
        });

        const parsed = JSON.parse(rr.choices?.[0]?.message?.content || '{}');
        const order: number[] = Array.isArray(parsed) ? parsed : parsed.order;
        if (Array.isArray(order) && order.every(n => Number.isInteger(n) && n >= 1 && n <= top.length)) {
          finalHits = order.map(i => top[i - 1]).concat(allHits.slice(top.length));
        }
      } catch {
        // ignore rerank errors; keep vector order
      }
    }

    // 5) Shape to your UI contract
    const results = finalHits.slice(0, matchCount).map(h => ({
      document_id: h.document_id,
      pdf_page_number: h.pdf_page_number,
      section_number: h.section_number,
      section_title: h.section_title,
      content: h.content,
      relevance_score: Number(h.similarity.toFixed(4)),
      content_offset: offsetMap.get(h.document_id) || null, // your UI optionally uses this
    }));

    return NextResponse.json({
      results,
      meta: {
        query,
        documents_considered: documentIds.length,
        embedding_model: 'text-embedding-3-small',
        threshold,
        matchCount,
        mode: searchMode,
        category: category ?? null,
      },
    });
  } catch (err: any) {
    console.error('ai-search error:', err?.message || err);
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
}
