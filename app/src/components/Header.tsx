"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ConnectButton } from "./ConnectButton";
import { MarketChip } from "./MarketChip";

const NAV = [
  { href: "/", label: "Play" },
  { href: "/founts", label: "Founts" },
  { href: "/burn", label: "Burn" },
  { href: "/safety", label: "Safety" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/how", label: "How it works" },
];

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  return (
    <header className="header">
      <Link href="/" className="brand">
        <svg className="brand-mark" viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r="44" />
          <path d="M28 54 L44 70 L74 34" className="brand-mark-shine" fill="none" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        StockCall
      </Link>
      <nav id="site-nav" className={open ? "nav open" : "nav"}>
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={(n.href === "/" ? pathname === "/" : pathname.startsWith(n.href)) ? "active" : undefined}>
            {n.label}
          </Link>
        ))}
        {open && <MarketChip />}
      </nav>
      <MarketChip />
      <ConnectButton />
      <button
        className="menu-btn"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="site-nav"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "✕" : "☰"}
      </button>
    </header>
  );
}
