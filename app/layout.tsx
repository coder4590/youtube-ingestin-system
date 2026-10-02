import type {Metadata} from 'next';
import './globals.css'; // Global styles

export const metadata: Metadata = {
  title: 'YouTube Ingestion & AI Brain Pipeline',
  description: 'Automated YouTube playlist & video ingestion system with yt-dlp, Cloudflare R2, OpenAI Whisper, and Supabase.',
  openGraph: {
    title: 'YouTube Ingestion & AI Brain Pipeline',
    description: 'Automated YouTube playlist & video ingestion system with yt-dlp, Cloudflare R2, OpenAI Whisper, and Supabase.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'YouTube Ingestion & AI Brain Pipeline',
    description: 'Automated YouTube playlist & video ingestion system with yt-dlp, Cloudflare R2, OpenAI Whisper, and Supabase.',
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
