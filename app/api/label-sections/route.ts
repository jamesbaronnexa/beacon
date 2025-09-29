// /app/api/label-sections/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

export const runtime = 'nodejs';
export const maxDuration = 60;

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase envs');
  return createClient(url, key, { auth: { persistSession: false } });
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

type GptLabel = {
  section_number: string | null;
  section_title: string | null;
  headings_on_page?: Array<{ number?: string; title: string }>;
  confidence: number; // 0..1
  rationale?: string;
};

const SYSTEM = `You are an expert indexer of electrical standards (AS/NZS 3000:2018).
Identify the PRIMARY heading for the page (e.g., "1", "1.1", "1.2.3").
Ignore headers/footers/watermarks/page numerals.
Accept single-line numeric ("1.1 SCOPE"), two-line number+title ("1" then "SCOPE"), and "Part/Section/Clause N: Title".
Normalize section_number to digits+dots only (e.g., "1", "1.1"). For "Part 1", use "1".
Return strict JSON only.`;

function firstNChars(s: string, n = 1200) {
  return (s || '').slice(0, n);
}
const isNumeric = (num: string | null | undefined) =>
  !!(num && /^\d+(?:\.\d+)*$/.test(num));
const canonTitle = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function makeUserPrompt(args: {
  pageNumber: number;
  snippet: string;
  heuristicNumber: string | null;
  heuristicTitle: string | null;
  prevNumber: string | null;
  prevTitle: string | null;
}) {
  const { pageNumber, snippet, heuristicNumber, heuristicTitle, prevNumber, prevTitle } = args;
  return [
    `Document: AS/NZS 3000:2018 (Wiring Rules)`,
    `Page: ${pageNumber}`,
    `Existing heading (may be null): number=${heuristicNumber ?? 'null'} | title=${heuristicTitle ?? 'null'}`,
    `Previous page heading (may be null): number=${prevNumber ?? 'null'} | title=${prevTitle ?? 'null'}`,
    `Text (first ~1200 chars, noise-trimmed):\n"""\n${snippet}\n"""`,
    `Output JSON schema:\n{\n  "section_number": string|null,\n  "section_title": string|null,\n  "headings_on_page": [ {"number":"1.1","title":"Scope"} ],\n  "confidence": number,\n  "rationale": string\n}`,
  ].join('\n');
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getAdminClient();
    const body = (await req.json().catch(() => ({}))) as {
      documentId: string;
      minConfidence?: number; // default 0.85
      limitPages?: number;
    };

    const { documentId, minConfidence = 0.85, limitPages } = body;
    if (!documentId) return NextResponse.json({ error: 'documentId required' }, { status: 400 });

    // Only fetch pages that NEED help (missing number or title)
    const { data: pages, error: pErr } = await supabase
      .from('pages')
      .select('id,pdf_page_number,content,section_number,section_title,page_type,metadata')
      .eq('document_id', documentId)
      .eq('page_type', 'content')
      .or('section_number.is.null,section_title.is.null') // <-- only missing
      .order('pdf_page_number', { ascending: true });

    if (pErr) throw pErr;
    if (!pages?.length) {
      return NextResponse.json({
        success: true,
        documentId,
        minConfidence,
        stats: { considered: 0, applied: 0, skippedAlreadyComplete: 0, belowConfidence: 0, noChange: 0 },
        changes: [],
        message: 'Nothing to do: all content pages already have number & title.',
      });
    }

    const work = limitPages ? pages.slice(0, limitPages) : pages;

    let applied = 0;
    let skippedAlreadyComplete = 0;
    let belowConfidence = 0;
    let noChange = 0;

    const changes: Array<{
      id: string;
      pdf_page_number: number;
      before_number: string | null;
      before_title: string | null;
      after_number: string | null;
      after_title: string | null;
      confidence: number;
      applied: boolean;
      reason?: string;
    }> = [];

    for (let i = 0; i < work.length; i++) {
      const page = work[i];
      const prev = i > 0 ? work[i - 1] : null;

      const beforeNum = page.section_number || null;
      const beforeTitle = page.section_title || null;

      // If both are already present, skip (shouldn't happen due to filter, but keep safe)
      if (beforeNum && beforeTitle) {
        skippedAlreadyComplete++;
        changes.push({
          id: page.id,
          pdf_page_number: page.pdf_page_number,
          before_number: beforeNum,
          before_title: beforeTitle,
          after_number: beforeNum,
          after_title: beforeTitle,
          confidence: 0,
          applied: false,
          reason: 'already complete',
        });
        continue;
      }

      // Call GPT only for genuinely missing info
      const userPrompt = makeUserPrompt({
        pageNumber: page.pdf_page_number,
        snippet: firstNChars(page.content || '', 1600),
        heuristicNumber: beforeNum,
        heuristicTitle: beforeTitle,
        prevNumber: prev?.section_number ?? null,
        prevTitle: prev?.section_title ?? null,
      });

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userPrompt },
        ],
      });

      let parsed: GptLabel = {
        section_number: beforeNum,
        section_title: beforeTitle,
        confidence: 0.3,
      };
      try {
        parsed = JSON.parse(completion.choices?.[0]?.message?.content || '{}') as GptLabel;
      } catch {}

      // NEVER change numbers: only fill if missing and parsed is clean numeric
      const afterNum =
        beforeNum ??
        (isNumeric(parsed.section_number) ? parsed.section_number!.trim() : null);

      // Titles: only fill if missing. Ignore case-only differences.
      const proposedTitle = parsed.section_title?.trim() || null;
      const afterTitle = beforeTitle ?? proposedTitle ?? null;

      const titleChanged = canonTitle(afterTitle) !== canonTitle(beforeTitle);
      const numChanged = afterNum !== beforeNum;
      const conf = parsed.confidence ?? 0;

      // If we didn’t actually add anything new, or confidence is low, skip
      if ((!numChanged && !titleChanged) || conf < minConfidence) {
        if (conf < minConfidence) belowConfidence++; else noChange++;
        changes.push({
          id: page.id,
          pdf_page_number: page.pdf_page_number,
          before_number: beforeNum,
          before_title: beforeTitle,
          after_number: afterNum,
          after_title: afterTitle,
          confidence: conf,
          applied: false,
          reason: conf < minConfidence ? `below minConfidence ${minConfidence}` : 'no change',
        });
        continue;
      }

      // Apply update (numbers only if they were NULL; titles only if they were NULL)
      const { error: updErr } = await supabase
        .from('pages')
        .update({
          section_number: afterNum,
          section_title: afterTitle,
          metadata: {
            ...((page as any).metadata ?? {}),
            gpt_label: {
              ...parsed,
              // store what we actually kept
              section_number: afterNum,
              section_title: afterTitle,
            },
          },
        })
        .eq('id', page.id);
      if (updErr) throw updErr;

      applied++;
      changes.push({
        id: page.id,
        pdf_page_number: page.pdf_page_number,
        before_number: beforeNum,
        before_title: beforeTitle,
        after_number: afterNum,
        after_title: afterTitle,
        confidence: conf,
        applied: true,
      });
    }

    return NextResponse.json({
      success: true,
      documentId,
      minConfidence,
      stats: {
        considered: work.length,
        applied,
        skippedAlreadyComplete,
        belowConfidence,
        noChange,
      },
      changes,
      note: 'Numbers are NEVER modified; only filled if missing. Titles only filled if missing. Case-only diffs are ignored.',
    });
  } catch (err: any) {
    console.error('label-sections error:', err?.message || err);
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
}
