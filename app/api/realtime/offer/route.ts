import { NextResponse } from 'next/server'

export async function POST(request) {
  console.log('🎯 Beacon Realtime API called');

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return NextResponse.json({ error: 'OpenAI API key not configured' }, { status: 500 });
  }

  try {
    const { sdp, pdfContext } = await request.json();
    
    if (!sdp) {
      throw new Error('No SDP in request body');
    }
    
    console.log('📤 SDP received for PDF search, length:', sdp.length);
    
    // Log user agent to debug mobile issues
    const userAgent = request.headers.get('user-agent') || 'Unknown';
    console.log('📱 User Agent:', userAgent);
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
    const isSamsung = /Samsung/i.test(userAgent);
    console.log('Is Mobile:', isMobile, 'Is Samsung:', isSamsung);
    
    // Use the same model as your tutor
    const model = 'gpt-4o-mini-realtime-preview-2024-12-17';
    const url = `https://api.openai.com/v1/realtime?model=${model}`;
    
    console.log('🌐 Calling OpenAI Realtime');
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/sdp',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: sdp
    });

    const responseText = await response.text();
    
    console.log('📥 OpenAI response status:', response.status);
    
    if (!response.ok) {
      console.error('❌ OpenAI error:', responseText);
      return NextResponse.json({ error: responseText }, { status: response.status });
    }
    
    console.log('✅ Realtime connection established!');
    
    // Set CORS headers for mobile compatibility
    const headers = new Headers({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    });
    
    return NextResponse.json({ sdp: responseText }, { headers });
    
  } catch (error) {
    console.error('❌ Server error:', error.message);
    console.error('Full error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function OPTIONS(request) {
  // Properly handle preflight requests for mobile
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  });
  
  return new NextResponse(null, { status: 200, headers });
}