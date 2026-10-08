import Link from "next/link";
import type { ReactNode } from "react";

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function AmountInput({
  value,
  onChange,
  symbol,
  max,
  onMax,
}: {
  value: string;
  onChange: (v: string) => void;
  symbol: string;
  max?: string;
  onMax?: () => void;
}) {
  return (
    <div className="amount-input">
      <input inputMode="decimal" placeholder="0.00" value={value} onChange={(e) => onChange(e.target.value.trim())} />
      <span className="symbol">{symbol}</span>
      {onMax && (
        <button type="button" className="max" onClick={onMax}>
          Max{max ? ` ${max}` : ""}
        </button>
      )}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange }: { tabs: readonly T[]; active: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t} className={t === active ? "tab active" : "tab"} onClick={() => onChange(t)}>
          {t}
        </button>
      ))}
    </div>
  );
}

export function NotDeployed({ what }: { what: string }) {
  return (
    <div className="card notice">
      <h3>{what} are not live on this network yet</h3>
      <p>
        StockCall contracts have not been deployed to the connected network. Addresses appear here automatically once a
        deployment is exported. See the <Link href="/docs">docs</Link> for the launch plan.
      </p>
    </div>
  );
}

export function Pill({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted" | "ember"; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}
