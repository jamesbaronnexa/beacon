// app/utils/nav-presets.ts

export type NavRanges = {
  toc?: { start: number; end: number };
  content?: { start: number; end: number };
  definitions?: { start: number; end: number };
  appendices?: { start: number; end: number };
  page_numbering?: {
    printed_offset?: number | null; // printed = pdf + offset
    source?: 'preset' | 'detected';
  };
};

export function getNavPresetFor(title: string, totalPages: number) {
  // Match AS/NZS 3000:2018 (Wiring Rules)
  if (/AS\/NZS\s*3000\s*:\s*2018/i.test(title)) {
    return {
      preset_fingerprint: 'asnzs-3000-2018',
      content_starts_at_page: 36,   // observed in your sample
      toc_ends_at_page: 35,
      nav_ranges: <NavRanges>{
        toc: { start: 7, end: 35 },             // adjust if your copy differs
        content: { start: 36, end: totalPages },// all after TOC
        definitions: { start: 39, end: 56 },    // Section 1.4 in your 0–100 sample
        // appendices: { start: 227, end: totalPages }, // for full book if you know it
        page_numbering: {
          printed_offset: null, // we’ll auto-detect; if you want to force, put -4 here & set source:'preset'
          source: 'detected'
        }
      }
    };
  }
  return null;
}

export type PageType = 'front_matter' | 'toc' | 'definitions' | 'appendix' | 'content';

export function classifyPageType(
  n: number,
  ranges: NavRanges | null,
  contentStart?: number | null
): PageType {
  if (ranges?.toc && n >= ranges.toc.start && n <= ranges.toc.end) return 'toc';
  if (ranges?.definitions && n >= ranges.definitions.start && n <= ranges.definitions.end) return 'definitions';
  if (ranges?.appendices && n >= ranges.appendices.start && n <= ranges.appendices.end) return 'appendix';
  if (contentStart && n >= contentStart) return 'content';
  return 'front_matter';
}
