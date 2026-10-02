import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getVideoById } from '@/lib/db';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const video = await getVideoById(id);
    if (!video) {
      return NextResponse.json({ error: `Video with ID ${id} not found` }, { status: 404 });
    }

    const publicAudioPath = path.join(process.cwd(), 'public', 'audio', `${video.source_id}.mp3`);
    if (fs.existsSync(publicAudioPath)) {
      const fileBuffer = fs.readFileSync(publicAudioPath);
      return new Response(fileBuffer, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Disposition': `attachment; filename="${video.source_id}.mp3"`,
          'Content-Length': fileBuffer.length.toString(),
        },
      });
    }

    if (video.storage_url && video.storage_url.startsWith('http')) {
      return NextResponse.redirect(video.storage_url);
    }

    return NextResponse.json(
      { error: "Audio file is not yet downloaded for this video. Click 'Transcribe Now' to trigger audio extraction." },
      { status: 404 }
    );
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Audio retrieval failed' }, { status: 500 });
  }
}
