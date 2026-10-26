import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  metadataBase: new URL('https://pro.dexdna.app'),
  title: 'DexDNA Pro | Cross-chain trading',
  description: 'The DexDNA cross-chain trading terminal. Explore markets and route trades across networks supported by Relay and Circle Gateway.',
  applicationName: 'DexDNA Pro',
  icons: {
    icon: [
      {
        url: '/datadnalogo.png',
        type: 'image/png',
      },
    ],
    apple: '/datadnalogo.png',
  },
  openGraph: {
    title: 'DexDNA Pro',
    description: 'Cross-chain markets and trading from DexDNA.',
    siteName: 'DexDNA Pro',
    images: [{ url: '/datadnalogo.png', width: 500, height: 500, alt: 'DexDNA logo' }],
  },
  twitter: {
    card: 'summary',
    title: 'DexDNA Pro',
    description: 'Cross-chain markets and trading from DexDNA.',
    images: ['/datadnalogo.png'],
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#eae7f5' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
