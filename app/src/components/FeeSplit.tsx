"use client";

import { useBurnQueue, useCallToken } from "@/hooks/useProtocol";
import { useDeployment } from "@/lib/deployment";
import { fmtUsdg } from "@/lib/format";
import { tradeUrl } from "@/lib/links";

const C = 2 * Math.PI * 40;

export function FeeSplit() {
  const { deployment } = useDeployment();
  const queue = useBurnQueue();
  const { token, pending } = useCallToken();
  return (
    <div className="split">
      <div>
        <h2>Where every fee dollar goes</h2>
        <p>
          The protocol&apos;s share is capped at 30% in the Fount contract. Governance can lower it and can never raise it. The
          contract that buys and burns $CALL has no withdrawal function, so what goes in only leaves as burned tokens.
        </p>
        <div className="burn">
          <div>
            <div className="label">$CALL buy-and-burn</div>
            <div className="burn-big">{deployment ? `${fmtUsdg(queue.usdg)} waiting` : "Starts at launch"}</div>
            <p>Collected fees are spent on $CALL and burned once its pool opens on Pons.</p>
          </div>
          {/* No generic launchpad link before launch: it would invite buying a lookalike token. */}
          {!pending && (
            <a className="btn btn-ember" href={tradeUrl(token)} target="_blank" rel="noreferrer">
              Trade $CALL on Pons ↗
            </a>
          )}
        </div>
      </div>
      <div className="ring">
        <svg viewBox="0 0 100 100" role="img" aria-label="70% of fees to depositors, 30% to $CALL buy-and-burn">
          <circle cx="50" cy="50" r="40" fill="none" stroke="var(--surface-2)" strokeWidth="14" />
          <circle cx="50" cy="50" r="40" fill="none" stroke="var(--accent)" strokeWidth="14" strokeDasharray={`${C * 0.7} ${C}`} transform="rotate(-90 50 50)" />
          <circle
            cx="50" cy="50" r="40" fill="none" stroke="var(--burn)" strokeWidth="14"
            strokeDasharray={`${C * 0.3} ${C}`} strokeDashoffset={-C * 0.7} transform="rotate(-90 50 50)"
          />
          <text x="50" y="49" textAnchor="middle" fill="var(--text)" fontFamily="var(--mono)" fontSize="13" fontWeight="600">70/30</text>
          <text x="50" y="61" textAnchor="middle" fill="var(--muted)" fontFamily="var(--body)" fontSize="6">enforced on-chain</text>
        </svg>
        <div className="legend">
          <div><i style={{ background: "var(--accent)" }} /><div><b>70%</b><span>compounds for depositors</span></div></div>
          <div><i style={{ background: "var(--burn)" }} /><div><b>30%</b><span>buys and burns $CALL</span></div></div>
          <div><i style={{ background: "var(--line-2)" }} /><div><b>48h</b><span>public delay on any change</span></div></div>
        </div>
      </div>
    </div>
  );
}
