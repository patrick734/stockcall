// Sealed reveals: a player's browser encrypts the reveal of a hidden Arena entry to the keeper's public key, so the
// inbox that stores it until the lock only ever holds ciphertext. Only the keeper key can open it.
//
// Format (hex): 0x01 | ephemeral public key (33 bytes, compressed) | iv (12 bytes) | AES-256-GCM ciphertext + tag
// Key: keccak256(ECDH shared point of the ephemeral key and the keeper key, uncompressed), AAD "stockcall-reveal-v1".
// Plaintext: JSON {"n": round, "player": address, "probs": decimal string, "salt": 0x 32-byte hex}.
// The app implements seal() with WebCrypto in the same format; scripts/unit.js checks the round trip.
const crypto = require("crypto");
const { ethers } = require("ethers");

const VERSION = 1;
const AAD = Buffer.from("stockcall-reveal-v1");

function key(secret) {
  return Buffer.from(ethers.getBytes(ethers.keccak256(secret)));
}

/** Encrypts a reveal to `publicKey` (the keeper's, any ethers-accepted form). Returns 0x-hex. */
function seal(publicKey, reveal) {
  const eph = new ethers.SigningKey(ethers.hexlify(crypto.randomBytes(32)));
  const k = key(eph.computeSharedSecret(publicKey));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  c.setAAD(AAD);
  const body = JSON.stringify({ n: Number(reveal.n), player: ethers.getAddress(reveal.player), probs: BigInt(reveal.probs).toString(), salt: ethers.hexlify(reveal.salt) });
  const ct = Buffer.concat([c.update(body, "utf8"), c.final(), c.getAuthTag()]);
  return ethers.hexlify(Buffer.concat([Buffer.from([VERSION]), Buffer.from(ethers.getBytes(eph.compressedPublicKey)), iv, ct]));
}

/** Decrypts a sealed reveal with the keeper's private key. Throws on anything malformed or tampered with. */
function open(privateKey, sealed) {
  const b = Buffer.from(ethers.getBytes(sealed));
  if (b.length < 1 + 33 + 12 + 16 + 2 || b[0] !== VERSION) throw new Error("not a sealed reveal");
  const ephPub = ethers.hexlify(b.subarray(1, 34));
  const iv = b.subarray(34, 46);
  const ct = b.subarray(46, b.length - 16);
  const tag = b.subarray(b.length - 16);
  const k = key(new ethers.SigningKey(privateKey).computeSharedSecret(ephPub));
  const d = crypto.createDecipheriv("aes-256-gcm", k, iv);
  d.setAAD(AAD);
  d.setAuthTag(tag);
  const r = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
  if (!Number.isSafeInteger(r.n) || r.n <= 0) throw new Error("bad round");
  const salt = ethers.hexlify(r.salt);
  if (ethers.dataLength(salt) !== 32) throw new Error("bad salt");
  return { n: r.n, player: ethers.getAddress(r.player), probs: BigInt(r.probs), salt };
}

/** The keeper's public key (compressed), for the app to seal reveals to. */
function publicKeyOf(privateKey) {
  return new ethers.SigningKey(privateKey).compressedPublicKey;
}

module.exports = { seal, open, publicKeyOf };
