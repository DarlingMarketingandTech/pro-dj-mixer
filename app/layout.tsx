import type {Metadata, Viewport} from 'next';
import { Archivo_Black, Inter, JetBrains_Mono } from 'next/font/google';
import { Toaster } from 'react-hot-toast';
import './globals.css'; // Global styles
import { withBasePath } from '@/lib/basePath';

const archivoBlack = Archivo_Black({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-heading',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'PRO DJ STUDIO',
  description: 'Virtual DJ Studio',
  manifest: withBasePath('/manifest.json'),
  icons: {
    icon: withBasePath('/favicon.ico'),
  },
};

export const viewport: Viewport = {
  themeColor: '#00FF00',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`dark ${archivoBlack.variable} ${inter.variable} ${jetbrainsMono.variable} font-sans`}>
      <body className="bg-background font-sans text-slate-100 min-h-screen flex flex-col antialiased transition-colors duration-300" suppressHydrationWarning>
        {children}
        <Toaster position="bottom-right" toastOptions={{
          style: {
            background: 'var(--color-studio-slate)',
            color: '#f8fafc',
            border: '1px solid rgba(212,175,55,0.25)',
          },
          success: {
            iconTheme: {
              primary: 'var(--color-studio-gold)',
              secondary: 'var(--color-studio-black)',
            },
          },
        }} />
      </body>
    </html>
  );
}
