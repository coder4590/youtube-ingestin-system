import { NextResponse } from 'next/server';
import { transcribeVideoById, getVideoById } from '@/lib/db';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const video = await getVideoById(id);
    if (!video) {
      return NextResponse.json({ error: `Video with ID ${id} not found` }, { status: 404 });
    }

    const updated = await transcribeVideoById(id);
    return NextResponse.json({
      message: `Transcription pipeline initiated for ${video.source_id}`,
      video: updated
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to trigger transcription' }, { status: 500 });
  }
}
