import { formatUnits, parseUnits } from "viem";

export const USDG_DECIMALS = 6;
export const CALL_SHARE_DECIMALS = 12;
export const WAD = 10n ** 18n;

export function fmtUsdg(value: bigint | undefined, digits = 2): string {
  if (value === undefined) return "…";
  const n = Number(formatUnits(value, USDG_DECIMALS));
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtAmount(value: bigint | undefined, decimals: number, digits = 4): string {
  if (value === undefined) return "…";
  const n = Number(formatUnits(value, decimals));
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtWadPct(value: bigint | undefined, digits = 2): string {
  if (value === undefined) return "…";
  return `${(Number(formatUnits(value, 18)) * 100).toFixed(digits)}%`;
}

export function fmtBps(bps: number | bigint | undefined): string {
  if (bps === undefined) return "…";
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

export function fmtHealth(value: bigint | undefined): string {
  if (value === undefined) return "…";
  if (value > 1000n * WAD) return "∞";
  return Number(formatUnits(value, 18)).toFixed(2);
}

export function safeParse(input: string, decimals: number): bigint | null {
  if (!input || !/^\d*\.?\d*$/.test(input)) return null;
  try {
    const v = parseUnits(input, decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export function shortAddress(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
