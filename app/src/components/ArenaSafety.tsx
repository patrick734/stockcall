"use client";

import { formatEther } from "viem";
import { useArenaProtocol } from "@/hooks/useArena";
import { Pill } from "./ui";

const same = (a?: string, b?: string) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

function Check({ ok, label, detail }: { ok: boolean | undefined; label: string; detail?: string }) {
  return (
    <li className="check">
      <Pill tone={ok === undefined ? "muted" : ok ? "ok" : "bad"}>{ok === undefined ? "…" : ok ? "Pass" : "Fail"}</Pill>
      <div>
        <div className="check-label">{label}</div>
        {detail && <div className="check-detail num">{detail}</div>}
      </div>
    </li>
  );
}

/** Arena and BuyBurn checks, read from the chain on every load. */
export function ArenaSafety() {
  const p = useArenaProtocol();
  const d = p.d;
  if (!d?.arena) return null;
  const not = (x: boolean | undefined) => (x === undefined ? undefined : !x);
  return (
    <div className="card">
      <h3>Arena</h3>
      <ul className="checks">
        <Check ok={p.timelockIsAdmin} label="The 48h timelock is the Arena's admin" detail={d.timelock} />
        <Check ok={not(p.deployerIsAdmin)} label="The deployer has no admin role on the Arena" detail={d.deployer} />
        <Check ok={p.feeSink === undefined ? undefined : same(p.feeSink, d.buyBurn)} label="Fees and forfeits can only go to BuyBurn" detail={d.buyBurn} />
        <Check ok={p.timelockBurnAdmin === undefined || p.deployerBurnAdmin === undefined ? undefined : p.timelockBurnAdmin && !p.deployerBurnAdmin} label="BuyBurn: timelock is admin, deployer is not; no withdraw function exists" />
        <Check ok={p.oracle === undefined ? undefined : same(p.oracle, d.oracle)} label="The price check reads the same Chainlink oracle as the Founts" detail={d.oracle} />
        <Check ok={p.guardTicks === undefined ? undefined : p.guardTicks >= 50 && p.guardTicks <= 2000} label={`Price check: rounds void beyond ${p.guardTicks !== undefined ? `${(p.guardTicks / 100).toFixed(1)}%` : "…"} from Chainlink (it cannot be switched off)`} />
        <Check ok={p.feeBps === undefined ? undefined : p.feeBps <= 1000} label={`Fee ${p.feeBps !== undefined ? p.feeBps / 100 : "…"}% of profit only (code cap 10%)`} />
        <Check ok={p.paused === undefined ? undefined : !p.paused} label="Entries open (the guardian can pause entries; never withdrawals, reveals or claims)" />
      </ul>
      <p className="muted small">Player balances held: {p.totalBalances !== undefined ? `${formatEther(p.totalBalances)} ETH` : "…"}. Only each player can withdraw their own.</p>
    </div>
  );
}
