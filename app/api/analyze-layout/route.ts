// /app/api/analyze-layout/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { parseLayoutAndInsert } from '../../utils/parse-azure-layout';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { randomUUID } from 'node:crypto';

const endpoint = (process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || '').replace(/\/$/, '');
const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY!;
const apiVersion = '2023-07-31';

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    if (!endpoint || !key) return NextResponse.json({ error: 'Missing Azure env vars' }, { status: 500 });

    const buf = Buffer.from(await file.arrayBuffer());
    const fileHash = crypto.createHash('sha256').update(buf).digest('hex');

    // 1) Submit to Azure
    const analyzeUrl = `${endpoint}/formrecognizer/documentModels/prebuilt-layout:analyze?api-version=${apiVersion}`;
    const submit = await fetch(analyzeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'Ocp-Apim-Subscription-Key': key },
      body: buf,
    });
    if (!submit.ok) {
      const detail = await submit.text();
      return NextResponse.json({ error: 'Azure analyze failed', detail }, { status: 502 });
    }

    // 2) Poll
    const pollUrl = submit.headers.get('operation-location');
    if (!pollUrl) return NextResponse.json({ error: 'Missing operation-location from Azure' }, { status: 502 });

    let analyzeResult: any = null;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const poll = await fetch(pollUrl, { headers: { 'Ocp-Apim-Subscription-Key': key } });
      const json = await poll.json();
      if (json.status === 'succeeded') { analyzeResult = json.analyzeResult; break; }
      if (json.status === 'failed') return NextResponse.json({ error: 'Azure analysis failed', detail: json }, { status: 502 });
    }
    if (!analyzeResult) return NextResponse.json({ error: 'Azure analysis timed out' }, { status: 504 });

    // 3) Save JSON for util
    const layoutPath = path.join('/tmp', `layout-${Date.now()}.json`);
    fs.writeFileSync(layoutPath, JSON.stringify(analyzeResult, null, 2));

    // 4) Preset for AS/NZS 3000 (override heuristics where needed)
    const PRESET_ASNZS_3000: Preset = {
      name: 'asnzs-3000-2018',
      title: 'AS/NZS 3000:2018',
      tocStart: 16,    // if you prefer 16–35 and 36+, set here
      tocEnd: 35,
      contentStart: 36,
      introStart: 34,
    };

    const documentId = randomUUID();
    const utilResult = await parseLayoutAndInsert(layoutPath, documentId, file.name, {
      preset: PRESET_ASNZS_3000,
      fileHash,
      azureModel: 'prebuilt-layout',
      azureLayoutPath: layoutPath,
    });

    return NextResponse.json({
      success: true,
      documentId,
      totalPages: analyzeResult?.pages?.length ?? null,
      presetApplied: utilResult.applied.preset,
      diagnostics: utilResult.applied,
      message: 'Inserted pages and document metadata into Supabase',
    });
  } catch (err: any) {
    return NextResponse.json({ error: 'Unexpected server error', detail: err?.message || String(err) }, { status: 500 });
  }
}

// Add this near the top of the file for TypeScript:
type Preset = {
  name: string; title: string; tocStart?: number; tocEnd?: number; introStart?: number; contentStart?: number;
};
