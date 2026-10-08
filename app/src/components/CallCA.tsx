"use client";

import { useState } from "react";
import { CALL_CA, tradeUrl } from "@/lib/links";

/** The $CALL contract address with copy and buy buttons. */
export function CallCA() {
  const [copied, setCopied] = useState(false);
  if (!CALL_CA) {
    return (
      <div className="ca">
        <span className="ca-label">$CALL</span>
        <span className="ca-soon">Launching on Pons soon. The address will only ever be posted here and on our X.</span>
      </div>
    );
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(CALL_CA);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }
  return (
    <div className="ca">
      <span className="ca-label">$CALL CA</span>
      <code className="ca-addr">{CALL_CA}</code>
      <span className="ca-actions">
        <button type="button" className="btn btn-sm" onClick={copy}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <a className="btn btn-sm btn-primary" href={tradeUrl(CALL_CA)} target="_blank" rel="noreferrer">
          Buy on Pons ↗
        </a>
      </span>
    </div>
  );
}
