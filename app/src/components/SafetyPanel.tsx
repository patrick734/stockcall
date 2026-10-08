"use client";

import { parseAbi, type Address } from "viem";
import { useReadContracts } from "wagmi";
import { fountAbi, fountOracleAbi } from "@/generated/abis";
import { useDeployment } from "@/lib/deployment";
import { Pill, NotDeployed } from "./ui";

const timelockAbi = parseAbi([
  "function getMinDelay() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function PROPOSER_ROLE() view returns (bytes32)",
]);
const ownableAbi = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)"]);
const ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

/// Must match FountOracle.Status.
const STATUS = ["Priced", "No feed", "Sequencer down", "Corporate action", "Stale", "Out of bounds", "Circuit breaker", "USDG stale", "USDG out of bounds", "USDG circuit breaker"];

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

export function SafetyPanel() {
  const { deployment: d, chainId } = useDeployment();
  const founts = d ? Object.entries(d.founts) : [];
  const tl = { address: d?.timelock, abi: timelockAbi, chainId } as const;
  const oracle = { address: d?.oracle, abi: fountOracleAbi, chainId } as const;
  const owned: Address[] = d ? [d.oracle, d.feeRouter, d.registry] : [];

  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(d), refetchInterval: 30_000 },
    contracts: [
      { ...tl, functionName: "getMinDelay" },
      { ...tl, functionName: "hasRole", args: [ADMIN_ROLE, (d?.deployer ?? d?.timelock) as Address] },
      { ...oracle, functionName: "maxJumpBps" },
      { ...oracle, functionName: "jumpCooldown" },
      ...owned.flatMap((a) => [
        { address: a, abi: ownableAbi, chainId, functionName: "owner" } as const,
        { address: a, abi: ownableAbi, chainId, functionName: "pendingOwner" } as const,
      ]),
      ...founts.flatMap(([, f]) => [
        { address: f.fount, abi: fountAbi, chainId, functionName: "hasRole", args: [ADMIN_ROLE, d!.timelock] } as const,
        { address: f.fount, abi: fountAbi, chainId, functionName: "hasRole", args: [ADMIN_ROLE, (d!.deployer ?? d!.timelock) as Address] } as const,
        { ...oracle, functionName: "status", args: [f.equityToken] } as const,
      ]),
    ],
  });

  if (!d) return <NotDeployed what="Safety checks" />;
  const r = (i: number) => (data?.[i]?.status === "success" ? data[i].result : undefined);
  const delay = r(0) as bigint | undefined;
  const deployerOnTimelock = r(1) as boolean | undefined;
  const jump = r(2) as number | undefined;
  const cooldown = r(3) as number | undefined;
  const base = 4;
  const ownersOk = data ? owned.every((_, i) => same(r(base + 2 * i) as string, d.timelock) && same(r(base + 2 * i + 1) as string, "0x0000000000000000000000000000000000000000")) : undefined;
  const fBase = base + owned.length * 2;
  const deployer = d.deployer;

  return (
    <div className="safety">
      <div className="card">
        <h3>Governance</h3>
        <ul className="checks">
          <Check ok={delay === undefined ? undefined : delay >= 172800n} label="Admin is a timelock with at least a 48-hour delay" detail={delay !== undefined ? `${Number(delay) / 3600}h · ${d.timelock}` : d.timelock} />
          <Check ok={deployer ? (deployerOnTimelock === undefined ? undefined : !deployerOnTimelock) : undefined} label="Deployer cannot administer the timelock" detail={deployer} />
          <Check ok={ownersOk} label="Oracle, fee router and registry are owned by the timelock, nothing pending" />
          {founts.map(([ticker], i) => {
            const adminOk = r(fBase + 3 * i) as boolean | undefined;
            const deployerAdmin = r(fBase + 3 * i + 1) as boolean | undefined;
            const ok = adminOk === undefined || deployerAdmin === undefined ? undefined : adminOk && (!deployer || !deployerAdmin);
            return <Check key={ticker} ok={ok} label={`${ticker} Fount: timelock is admin, deployer is not`} />;
          })}
        </ul>
        <p className="muted small">Guardian {d.roles?.guardian} can pause and lower caps only. Keeper {d.roles?.keeper} can rebalance within oracle-checked loss limits.</p>
      </div>

      <div className="card">
        <h3>Prices</h3>
        <p className="muted small">
          Circuit breaker: a move of more than {jump !== undefined ? `${jump / 100}%` : "…"} between two Chainlink rounds is held for{" "}
          {cooldown !== undefined ? `${Math.round(cooldown / 60)} minutes` : "…"}. Deposits and USDG exits wait; in-kind exits stay open.
        </p>
        <ul className="checks">
          {founts.map(([ticker], i) => {
            const s = r(fBase + 3 * i + 2) as number | undefined;
            return <Check key={ticker} ok={s === undefined ? undefined : s === 0} label={`${ticker}: ${s === undefined ? "loading" : STATUS[s] ?? `status ${s}`}`} />;
          })}
        </ul>
      </div>
    </div>
  );
}
