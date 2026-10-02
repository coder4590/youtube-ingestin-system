import { NextResponse } from 'next/server';
import { getReadyTranscripts } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10), 1), 200);
  const offset = Math.max(parseInt(searchParams.get('offset') || '0', 10), 0);

  try {
    const { transcripts, count, total } = await getReadyTranscripts(limit, offset);

    return NextResponse.json({
      status: "success",
      count,
      total,
      transcripts
    });
  } catch (err: any) {
    return NextResponse.json({ status: "error", error: err.message }, { status: 500 });
  }
}
