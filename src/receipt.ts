// src/receipt.ts
/**
 * Mint receipts — the provenance bond from quilt-esp32's reflex arc.
 *
 * On the boat firmware, `critic-gate.qm` carries the sha256 of the
 * exact `gate-bands.json` bytes it was minted from, and the firmware
 * **refuses to judge** if the board's receipt doesn't match. Same move
 * here, one level up: when a boat mints a journal artifact (the
 * serialized cell ledger), the sha256 of the exact artifact bytes is
 * the receipt. Every gossip packet about that journal carries it:
 *
 *     { boat_id, cell_id, receipt_sha, chain_head, ts, tier }
 *
 * A receiver that pulls the journal recomputes the receipt over the
 * exact bytes it received and refuses the journal if they disagree.
 * No keys, no signatures — sha256 over pinned bytes, like the mint.
 */

import { canonicalJson, sha256Hex, type Hash, type JournalJson } from "./ledger.js";

/** Fleet tiers. Metadata for fleet routing policy in v0.1 — displayed
 *  by `status`, not yet used to make routing decisions (honestly). */
export type Tier = "flagship" | "boat" | "skiff";

/**
 * A gossip message is a mint receipt: one boat telling the fleet "I
 * hold this cell's journal, sealed at this head, with this receipt."
 */
export interface GossipPacket {
  /** Who holds the journal. */
  boat_id: string;
  /** Which cell's ledger the receipt is for. */
  cell_id: string;
  /** sha256 of the exact canonical bytes of the full journal
   *  artifact, as minted. */
  receipt_sha: Hash;
  /** The journal's chain head (last entry hash, or the genesis
   *  commit for an empty ledger). */
  chain_head: Hash;
  /** When this receipt was minted (millis since epoch). */
  ts: number;
  /** The holder's fleet tier. */
  tier: Tier;
}

/** The canonical bytes of a journal artifact — the exact bytes a
 *  receipt is taken over, on every boat, every time. */
export function journalBytes(journal: JournalJson): string {
  return canonicalJson(journal as unknown as Parameters<typeof canonicalJson>[0]);
}

/** Mint a receipt: sha256 over the exact canonical journal bytes. */
export function mintReceipt(journal: JournalJson): Hash {
  return sha256Hex(journalBytes(journal));
}

/**
 * The reflex-arc check: does this journal's exact bytes hash to the
 * receipt a peer advertised? A lying peer fails this even if its
 * internal chain verifies (e.g. it minted a different journal and
 * stamped someone else's receipt on it).
 */
export function verifyReceipt(journal: JournalJson, receiptSha: Hash): boolean {
  return mintReceipt(journal) === receiptSha;
}

/** Build a gossip packet (a mint receipt) for a journal a boat holds. */
export function packetFor(
  boatId: string,
  tier: Tier,
  journal: JournalJson,
  head: Hash,
  ts: number,
): GossipPacket {
  return {
    boat_id: boatId,
    cell_id: journal.cell_id,
    receipt_sha: mintReceipt(journal),
    chain_head: head,
    ts,
    tier,
  };
}
