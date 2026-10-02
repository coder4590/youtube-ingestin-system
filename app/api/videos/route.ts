import { NextResponse } from 'next/server';
import { getVideos, addVideo } from '@/lib/db';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10), 1), 100);
    const videos = await getVideos(limit);
    return NextResponse.json(videos);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to get videos' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const videoUrl = (body.video_url || '').trim();

    if (!videoUrl) {
      return NextResponse.json({ error: "Missing video_url in request" }, { status: 400 });
    }

    const { video, action } = await addVideo(videoUrl);

    if (action === 'deduplicated') {
      return NextResponse.json({
        message: `Video ${video.source_id} already exists in database with status ${video.status}. Deduplication applied.`,
        source_id: video.source_id,
        status: video.status,
        action: "deduplicated",
        video
      });
    }

    return NextResponse.json({
      message: `Video queued successfully in pipeline [source_id: ${video.source_id}]`,
      source_id: video.source_id,
      status: video.status,
      action: "created",
      video
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Failed to add video' }, { status: 400 });
  }
}
