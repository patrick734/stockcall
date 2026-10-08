import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Inter } from "next/font/google";
import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { Providers } from "@/components/Providers";
import "./globals.css";

const display = Fraunces({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const body = Inter({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-mono", display: "swap" });

// Absolute base for link-preview images. NEXT_PUBLIC_SITE_URL overrides the production domain.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://stockcall.fun";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "StockCall",
  openGraph: {
    title: "StockCall",
    description: "Call the hour on tokenized stocks. Hidden-entry forecast rounds and oracle-guarded liquidity on Robinhood Chain.",
    siteName: "StockCall",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "StockCall", description: "Call the hour on tokenized stocks. Hidden-entry forecast rounds and oracle-guarded liquidity on Robinhood Chain." },
  description:
    "StockCall: hourly forecast rounds on NVIDIA, Alphabet and ETH with hidden entries and a Chainlink price check, plus Founts that provide oracle-guarded liquidity for tokenized stocks. Every fee burns $CALL. Every admin action waits 48 hours in a public timelock.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <Header />
          <main>{children}</main>
          <footer className="footer">
            <span>StockCall. Independent software, not affiliated with Robinhood, Uniswap or any issuer.</span>
            <span className="num">Robinhood Chain · Uniswap · Chainlink · 48h timelock · forecast rounds may not be allowed where you live</span>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
