// app/utils/parse-azure-layout.ts
// - Robust heading detection: numeric (1.1), two-line number+title, Section/Clause N,
//   **Part N: Title**, and two-line Part/Section
// - Paragraph-based fallback (uses Azure paragraphs if lines fail)
// - Heuristic TOC/content detection + preset override (AS/NZS 3000)
// - Noise stripping for watermarks/page numbers
// - Printed page numbering offset detection (nav_ranges.page_numbering.printed_offset)
// - Idempotent page replace, document diagnostics

import { createClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

// ---------------------------
// Types
// ---------------------------
type Preset = {
  name: string;
  title: string;
  tocStart?: number;
  tocEnd?: number;
  introStart?: number;
  contentStart?: number;
};

type ParseOptions = {
  preset?: Preset;
  fileHash?: string;
  azureModel?: string;
  azureLayoutPath?: string;
};

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing Supabase envs. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------
// Text heuristics
// ---------------------------
// Numeric heading like "1.1 SCOPE" or "2 SWITCHBOARDS"
const HEADING_RE = /^\s*(\d{1,2}(?:\.\d{1,2}){0,4})\s+([A-Z][\w \-–—,:;/().]{2,120})$/i;
const NUM_ONLY_RE = /^(\d{1,2}(?:\.\d{1,2}){0,4})$/;
// Section/Clause patterns
const SECTION_LINE_RE = /^(Section|Clause)\s+(\d{1,2}(?:\.\d{1,2}){0,4})\s+(.{2,120})$/i;
const SECTION_ONLY_RE = /^(Section|Clause)\s+(\d{1,2}(?:\.\d{1,2}){0,4})\s*$/i;
// **Part** patterns (to catch "Part 1: Scope, application and fundamental principles")
const PART_LINE_RE = /^(Part)\s+(\d{1,2})\s*[:\-–—]\s*(.{2,180})$/i;
const PART_ONLY_RE = /^(Part)\s+(\d{1,2})\s*$/i;

const SECTION_HEADER_RE = /^(Part|Section)\s+\d+\b/i; // for content-start heuristic
const CONTENTS_HEADER_RE = /^CONTENTS\b/i;
const CLAUSE_RE = /\b(\d{1,2}(?:\.\d{1,2}){1,4})\b/;

function isLikelyPageNumber(line: string) {
  return /^\d{1,3}$/.test(line.trim());
}
function isAllCapsish(s: string) {
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (!letters) return false;
  const upper = letters.replace(/[a-z]/g, '');
  return upper.length / letters.length > 0.8;
}

// Kill obvious watermark/header/footer noise (keep this conservative)
function isNoise(line: string) {
  const s = line.trim();
  if (!s) return true;
  if (/Electrical Workers Licensing Group/i.test(s)) return true;
  if (/auto login/i.test(s)) return true;
  if (/temporarily download this document/i.test(s)) return true;
  if (/may print this document/i.test(s)) return true;
  if (/AS\/[NZ]S\s*3000:2018/i.test(s)) return true; // short repeated header
  if (isLikelyPageNumber(s)) return true;
  if (s.length <= 2) return true;
  return false;
}
function stripNoise(lines: string[]) {
  return lines.filter((ln) => !isNoise(ln));
}

function scoreTocLine(line: string): number {
  const endsWithPage = /\s(\d{1,3})\s*$/.test(line);
  const hasNumberedHead = /^(\s*\d+(?:\.\d+){0,3}|\s*Section\s+\d+|\s*Part\s+\d+)/i.test(line);
  const hasDots = /\.{3,}/.test(line);
  return (endsWithPage ? 1 : 0) + (hasNumberedHead ? 1 : 0) + (hasDots ? 1 : 0);
}
function countClauseHits(lines: string[]): number {
  return lines.reduce((c, ln) => c + (CLAUSE_RE.test(ln) ? 1 : 0), 0);
}

function findFirstHeadingAnywhere(lines: string[]) {
  // 1) Single-line numeric heading
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const m = ln.match(HEADING_RE);
    if (m) return { number: m[1].trim(), title: m[2].replace(/\.+\s*$/, '').trim(), raw: ln, index: i };
  }
  // 2) Two-line number + title
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i].trim();
    const b = lines[i + 1].trim();
    const mNum = NUM_ONLY_RE.exec(a);
    if (mNum && b.length >= 3 && (isAllCapsish(b) || /^[A-Z][\w \-–—,:;/().]{2,180}$/.test(b))) {
      return { number: mNum[1], title: b.replace(/\.+\s*$/, ''), raw: a + ' / ' + b, index: i };
    }
  }
  // 3) Section/Clause in one line
  for (let i = 0; i < lines.length; i++) {
    const m = SECTION_LINE_RE.exec(lines[i].trim());
    if (m) return { number: m[2].trim(), title: m[3].replace(/\.+\s*$/, '').trim(), raw: lines[i], index: i };
  }
  // 3b) **Part** in one line (with colon or dash)
  for (let i = 0; i < lines.length; i++) {
    const m = PART_LINE_RE.exec(lines[i].trim());
    if (m) return { number: m[2].trim(), title: m[3].replace(/\.+\s*$/, '').trim(), raw: lines[i], index: i };
  }
  // 4) Section only + next line title
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i].trim();
    const b = lines[i + 1].trim();
    const mSec = SECTION_ONLY_RE.exec(a);
    if (mSec && b.length >= 3 && (isAllCapsish(b) || /^[A-Z][\w \-–—,:;/().]{2,180}$/.test(b))) {
      return { number: mSec[2], title: b.replace(/\.+\s*$/, ''), raw: a + ' / ' + b, index: i };
    }
  }
  // 4b) **Part** only + next line title
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i].trim();
    const b = lines[i + 1].trim();
    const mPart = PART_ONLY_RE.exec(a);
    if (mPart && b.length >= 3 && (isAllCapsish(b) || /^[A-Z][\w \-–—,:;/().]{2,180}$/.test(b))) {
      return { number: mPart[2], title: b.replace(/\.+\s*$/, ''), raw: a + ' / ' + b, index: i };
    }
  }
  return null;
}

function detectTocRange(allPagesLines: string[][]): { start?: number; end?: number } {
  const maybeIdx = allPagesLines.findIndex((lines) => lines.some((l) => CONTENTS_HEADER_RE.test(l.trim())));
  const scores = allPagesLines.map((lines) => lines.reduce((acc, ln) => acc + scoreTocLine(ln), 0));
  let start: number | undefined = maybeIdx >= 0 ? maybeIdx + 1 : undefined;
  let end: number | undefined = start;
  if (start) {
    for (let i = start - 1; i < allPagesLines.length; i++) {
      if (scores[i] >= 3) end = i + 1;
      else break;
    }
    return { start, end };
  }
  const maxIndex = Math.max(10, Math.ceil(allPagesLines.length * 0.4));
  for (let i = 0; i < Math.min(scores.length, maxIndex); i++) {
    if (scores[i] >= 3) {
      if (start === undefined) start = i + 1;
      end = i + 1;
    } else if (start && end && i - (end - 1) > 2) break;
  }
  return { start, end };
}

function detectContentStart(allPagesLines: string[][]): number | undefined {
  for (let i = 0; i < allPagesLines.length; i++) {
    const cleaned = stripNoise(allPagesLines[i]);
    if (cleaned.some((l) => SECTION_HEADER_RE.test(l.trim()))) return i + 1;
    const heading = findFirstHeadingAnywhere(cleaned);
    const clauseHits = countClauseHits(cleaned);
    if (heading && heading.number && i > 10) return i + 1;
    if (clauseHits >= 6 && i > 10) return i + 1;
  }
  return undefined;
}

// Paragraph-based fallback (lines might miss a PART/SECTION if Azure grouped it)
function findHeadingFromParagraphs(analyzeResult: any, pageNumber: number) {
  const paras: any[] = Array.isArray(analyzeResult?.paragraphs) ? analyzeResult.paragraphs : [];
  const onPage = paras.filter(
    (p) => Array.isArray(p?.boundingRegions) && p.boundingRegions.some((br: any) => br.pageNumber === pageNumber)
  );

  const rolePref = onPage
    .filter((p) => typeof p?.role === 'string' && /heading|title/i.test(p.role))
    .concat(onPage.filter((p) => !p.role));

  for (let i = 0; i < rolePref.length; i++) {
    const t = String(rolePref[i]?.content || '').trim();
    if (!t) continue;

    let m = t.match(HEADING_RE);
    if (m) return { number: m[1].trim(), title: m[2].replace(/\.+\s*$/, '').trim(), raw: t };

    m = SECTION_LINE_RE.exec(t);
    if (m) return { number: m[2].trim(), title: m[3].replace(/\.+\s*$/, '').trim(), raw: t };

    let mp = PART_LINE_RE.exec(t);
    if (mp) return { number: mp[2].trim(), title: mp[3].replace(/\.+\s*$/, '').trim(), raw: t };

    const mNum = NUM_ONLY_RE.exec(t);
    if (mNum && i + 1 < rolePref.length) {
      const t2 = String(rolePref[i + 1]?.content || '').trim();
      if (t2 && (isAllCapsish(t2) || /^[A-Z][\w \-–—,:;/().]{2,180}$/.test(t2))) {
        return { number: mNum[1], title: t2.replace(/\.+\s*$/, '').trim(), raw: t + ' / ' + t2 };
      }
    }

    const mSecOnly = SECTION_ONLY_RE.exec(t);
    if (mSecOnly && i + 1 < rolePref.length) {
      const t2 = String(rolePref[i + 1]?.content || '').trim();
      if (t2 && (isAllCapsish(t2) || /^[A-Z][\w \-–—,:;/().]{2,180}$/.test(t2))) {
        return { number: mSecOnly[2], title: t2.replace(/\.+\s*$/, '').trim(), raw: t + ' / ' + t2 };
      }
    }

    const mPartOnly = PART_ONLY_RE.exec(t);
    if (mPartOnly && i + 1 < rolePref.length) {
      const t2 = String(rolePref[i + 1]?.content || '').trim();
      if (t2 && (isAllCapsish(t2) || /^[A-Z][\w \-–—,:;/().]{2,180}$/.test(t2))) {
        return { number: mPartOnly[2], title: t2.replace(/\.+\s*$/, '').trim(), raw: t + ' / ' + t2 };
      }
    }
  }
  return null;
}

// ---------------------------
// Printed page number helpers (work on RAW lines, not noise-stripped)
// ---------------------------
function detectPrintedNumberFromLines(lines: string[]): number | null {
  const arr = (lines || []).map((s) => String(s || '').trim()).filter(Boolean);
  // Scan last ~6 lines; footers are common
  for (let i = arr.length - 1; i >= Math.max(0, arr.length - 6); i--) {
    const ln = arr[i];
    let m = ln.match(/^(\d{1,4})$/);
    if (m) return parseInt(m[1], 10);

    // common pattern in your PDF: header/footer with AS/NZS 3000 near the number
    if (/AS\/[NZ]S\s*3000/i.test(ln)) {
      const nxt = arr[i + 1];
      if (nxt) {
        m = nxt.match(/^(\d{1,4})$/);
        if (m) return parseInt(m[1], 10);
      }
      const prv = arr[i - 1];
      if (prv) {
        m = prv.match(/^(\d{1,4})$/);
        if (m) return parseInt(m[1], 10);
      }
    }
  }
  // Try top of page too (some PDFs print number at the top)
  for (let i = 0; i < Math.min(4, arr.length); i++) {
    const m = arr[i].match(/^(\d{1,4})$/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function medianInt(nums: number[]): number | null {
  if (!nums.length) return null;
  const arr = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : Math.round((arr[mid - 1] + arr[mid]) / 2);
}

// ---------------------------
// Main
// ---------------------------
export async function parseLayoutAndInsert(
  layoutPath: string,
  documentId: string,
  filename: string,
  options: ParseOptions = {}
) {
  const supabase = getAdminClient();

  const analyzeResult = JSON.parse(fs.readFileSync(layoutPath, 'utf-8'));
  const pagesArr: any[] = Array.isArray(analyzeResult?.pages) ? analyzeResult.pages : [];
  const totalPages = pagesArr.length;

  const allPagesLines: string[][] = pagesArr.map((p) =>
    Array.isArray(p?.lines) ? p.lines.map((l: any) => String(l.content || '')) : []
  );

  const tocGuess = detectTocRange(allPagesLines);
  const contentGuess = detectContentStart(allPagesLines);

  const defaultPreset: Preset = {
    name: 'asnzs-3000-2018',
    title: 'AS/NZS 3000:2018',
    tocStart: 16,
    tocEnd: 35,
    introStart: 30,
    contentStart: 36,
  };

  const preset = options.preset ?? defaultPreset;
  const pageMap = {
    tocStart: preset?.tocStart ?? tocGuess.start,
    tocEnd: preset?.tocEnd ?? tocGuess.end,
    introStart: preset?.introStart,
    contentStart: preset?.contentStart ?? contentGuess,
  };

  // Build page rows (content is noise-stripped)
  const rows = pagesArr.map((p, idx) => {
    const pageNumber = p.pageNumber ?? idx + 1;
    const rawLines = allPagesLines[idx] || [];
    const cleaned = stripNoise(rawLines);

    // Try lines, then paragraphs fallback
    let firstHeading = findFirstHeadingAnywhere(cleaned);
    if (!firstHeading) {
      const paraHead = findHeadingFromParagraphs(analyzeResult, pageNumber);
      if (paraHead) firstHeading = { ...paraHead, index: 0 } as any;
    }

    const clauseHits = countClauseHits(cleaned);

    let page_type: 'title' | 'toc' | 'content' | 'preliminary' | 'other' = 'other';
    if (pageNumber === 1) page_type = 'title';
    else if (
      pageMap.tocStart &&
      pageMap.tocEnd &&
      pageNumber >= pageMap.tocStart &&
      pageNumber <= pageMap.tocEnd
    ) {
      page_type = 'toc';
    } else if (pageMap.contentStart && pageNumber >= pageMap.contentStart) {
      page_type = 'content';
    } else if (
      pageMap.introStart &&
      pageNumber >= pageMap.introStart &&
      (!pageMap.contentStart || pageNumber < pageMap.contentStart)
    ) {
      page_type = 'preliminary';
    } else {
      page_type = 'preliminary';
    }

    const section_number = firstHeading?.number ?? null; // for "Part 1: ..." this will be "1"
    const section_title = firstHeading?.title ?? null; // e.g., "Scope, application and fundamental principles"

    return {
      id: uuidv4(),
      document_id: documentId,
      pdf_page_number: pageNumber,
      content: cleaned.join('\n'),
      page_type,
      section_title,
      section_number,
      embedding: null,
      is_content: page_type === 'content',
      key_topics: [],
      chunk_type: 'page',
      metadata: {
        clause_hits: clauseHits,
        first_heading_raw: firstHeading?.raw ?? null,
        heuristics: {
          tocStart: pageMap.tocStart ?? null,
          tocEnd: pageMap.tocEnd ?? null,
          contentStart: pageMap.contentStart ?? null,
          introStart: pageMap.introStart ?? null,
        },
      },
    } as any;
  });

  // --- Printed page numbering offset detection -------------------------------
  // We want: printed = pdf + offset  =>  offset = printed - pdf
  const contentStartPage = pageMap.contentStart ?? 1;
  const sampleWindowEnd = Math.min(totalPages, (contentStartPage ?? 1) + 20);
  const offsets: number[] = [];
  for (let pdf = contentStartPage; pdf <= sampleWindowEnd; pdf++) {
    const linesRaw = allPagesLines[pdf - 1] || [];
    const printed = detectPrintedNumberFromLines(linesRaw);
    if (printed != null && Number.isFinite(printed)) {
      offsets.push(printed - pdf);
    }
  }
  const printedOffset = medianInt(offsets);

  // Build nav_ranges JSON we’ll store on documents
  const nav_ranges: any = {
    toc:
      pageMap.tocStart && pageMap.tocEnd
        ? { start: pageMap.tocStart, end: pageMap.tocEnd }
        : undefined,
    content: pageMap.contentStart ? { start: pageMap.contentStart, end: totalPages } : undefined,
    page_numbering: {
      printed_offset: printedOffset ?? null,
      source: printedOffset != null ? 'detected' : 'none',
    },
  };

  // Idempotency: clear old pages for this doc id (if any)
  await getAdminClient().from('pages').delete().eq('document_id', documentId);

  const docPayload: any = {
    id: documentId,
    title: preset?.title ?? filename,
    filename,
    content_starts_at_page: pageMap.contentStart ?? null,
    toc_ends_at_page: pageMap.tocEnd ?? null,
    uploaded_at: new Date().toISOString(),
    category: 'electrical',
    total_pages: totalPages,
    processed: true,
    total_chunks: rows.length,
    status: 'parsed',
    preset_fingerprint: options.fileHash ?? null,
    content_hash: options.fileHash ?? null,
    azure_layout_result: {
      model: options.azureModel ?? 'prebuilt-layout',
      analyze_version: '2023-07-31',
      total_pages: totalPages,
      file_hash: options.fileHash ?? null,
      preset_applied: preset?.name ?? null,
      toc_detected: tocGuess,
      content_detected: contentGuess ?? null,
    },
    // NEW: navigation ranges + printed page offset
    nav_ranges,
  };

  const { error: docErr } = await supabase.from('documents').upsert([docPayload], { onConflict: 'id' });
  if (docErr) throw docErr;

  const { error: pageErr } = await supabase.from('pages').insert(rows);
  if (pageErr) throw pageErr;

  return {
    inserted: rows.length,
    totalPages,
    applied: {
      preset: preset?.name ?? null,
      tocStart: pageMap.tocStart ?? null,
      tocEnd: pageMap.tocEnd ?? null,
      contentStart: pageMap.contentStart ?? null,
      introStart: pageMap.introStart ?? null,
      printedOffset: printedOffset ?? null,
    },
  };
}

export type { Preset, ParseOptions };
