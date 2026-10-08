import { ArenaSafety } from "@/components/ArenaSafety";
import { SafetyPanel } from "@/components/SafetyPanel";

export const metadata = { title: "Safety · StockCall" };

export default function SafetyPage() {
  return (
    <div className="page">
      <section className="section">
        <div className="section-head">
          <div>
            <h1>Safety rails, checked live</h1>
            <p>
              Read straight from the contracts on every load. For a full audit trail, run{" "}
              <code>npx hardhat run scripts/verify.js --network robinhood</code> from the repository.
            </p>
          </div>
        </div>
        <ArenaSafety />
        <SafetyPanel />
      </section>
    </div>
  );
}
