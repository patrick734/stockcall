import { secp256k1 } from "@noble/curves/secp256k1";
import { concat, getAddress, hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";

// Seals a reveal to the keeper's public key, in the format keeper/src/sealed.js opens:
// 0x01 | ephemeral public key (33 bytes, compressed) | iv (12) | AES-256-GCM ciphertext + tag,
// key = keccak256(uncompressed ECDH point), AAD "stockcall-reveal-v1".
const AAD = new TextEncoder().encode("stockcall-reveal-v1");

export type Reveal = { n: number; player: Address; probs: bigint; salt: Hex };

export async function seal(keeperPublicKey: Hex, r: Reveal): Promise<Hex> {
  const eph = secp256k1.utils.randomPrivateKey();
  const shared = secp256k1.getSharedSecret(eph, hexToBytes(keeperPublicKey), false);
  const keyBytes = new Uint8Array(hexToBytes(keccak256(shared)));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new TextEncoder().encode(JSON.stringify({ n: r.n, player: getAddress(r.player), probs: r.probs.toString(), salt: r.salt }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, body));
  return concat([toHex(new Uint8Array([1])), toHex(secp256k1.getPublicKey(eph, true)), toHex(iv), toHex(ct)]);
}

/** The message a player signs to store a sealed reveal in the relay inbox. */
export const inboxMessage = (n: number, sealedHash: Hex) => `StockCall auto-reveal\nRound: ${n}\nSealed: ${sealedHash}`;
