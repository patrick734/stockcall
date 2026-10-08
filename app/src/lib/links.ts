// $CALL trades on the Pons launchpad, whose token pages are /launchpad/<address>. NEXT_PUBLIC_CALL_TRADE_URL overrides.
export const tradeUrl = (token?: string) =>
  process.env.NEXT_PUBLIC_CALL_TRADE_URL || `https://www.ponsfamily.com/launchpad${token ? `/${token}` : ""}`;
// The $CALL token on Pons, once launched. The burns use whatever BuyBurn and DrawdownRetire hold on-chain; this is
// for display and trading links before the timelock sets it. Empty until NEXT_PUBLIC_CALL_CA is set.
export const CALL_CA = (process.env.NEXT_PUBLIC_CALL_CA || "") as `0x${string}` | "";
/** Set NEXT_PUBLIC_X_URL once the X account exists; the link stays hidden until then. */
export const X_URL = process.env.NEXT_PUBLIC_X_URL || "";
