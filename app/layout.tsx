import type { Metadata } from 'next';
import { Plus_Jakarta_Sans } from 'next/font/google';
import Ambience from './Ambience';
import './globals.css';

/**
 * Self-hosted rather than linked from fonts.googleapis.com: one fewer
 * third-party round trip, and no flash of fallback type. That is worth more on
 * Zambian school wifi than anywhere else.
 */
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-jakarta',
});

export const metadata: Metadata = {
  title: 'LOTS AI',
  description: 'Lusaka Oaktree School — weekly planning and lesson evaluation',
};

export const viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={jakarta.variable}>
      <body>
        <Ambience />
        {children}
      </body>
    </html>
  );
}
