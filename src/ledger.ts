// src/ledger.ts
/**
 * The CellLedger — TypeScript port of the quilt-rust hash-chained,
 * double-entry cell ledger (packages/core/src/ledger.rs).
 *
 * A per-cell, append-only record of every input→output transaction a
 * cell ever performs. Every entry commits to the hash of its
 * predecessor plus its own canonical body; the empty chain's hash
 * commits to the cell id and genesis state, so identity is in the
 * chain. Editing any entry breaks every hash after it.
 *
 * The hash preimage is canonical JSON: compact, object keys sorted by
 * UTF-8 byte order, numbers rendered per the pinned semantics in
 * docs/cell-ledger.md (integers as integers, floats as shortest
 * round-trip). SHA-256 is Node's `node:crypto` — real, standard, and
 * the only "crypto" in this whole system. No signatures, no keys:
 * the chain is the seal.
 */

import { createHash } from "node:crypto";

/** A ledger hash: 64 lowercase hex characters (SHA-256). */
export type Hash = string;

/** The kind string committed by every chain root. */
export const GENESIS_KIND = "quilt-cell-ledger/1";

// ---------------------------------------------------------------------------
// SHA-256 — via node:crypto (FIPS 180-4)
// ---------------------------------------------------------------------------

export function sha256Hex(data: string | Uint8Array): Hash {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Canonical JSON — the hash preimage form
// ---------------------------------------------------------------------------

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonRecord = { [k: string]: Json };

/**
 * Canonical JSON, mirroring quilt-rust `canonical_json`:
 * compact, object keys sorted by UTF-8 byte order, numbers per the
 * pinned semantics below.
 *
 * Number semantics (honest divergence, documented): JS numbers are all
 * doubles. Integer-valued numbers (within ±2^53) render as integers —
 * matching serde_json for int inputs. Non-integers render shortest
 * round-trip decimal, with exponent notation expanded (`1e21` →
 * `1000000000000000000000`). Fixtures stay in the exact range where
 * this matches quilt-rust bit-for-bit.
 */
export function canonicalJson(v: Json): string {
  const out: string[] = [];
  writeCanonical(v, out);
  return out.join("");
}

function writeCanonical(v: Json, out: string[]): void {
  if (v === null) {
    out.push("null");
    return;
  }
  switch (typeof v) {
    case "boolean":
      out.push(v ? "true" : "false");
      return;
    case "number":
      out.push(canonicalNumber(v));
      return;
    case "string":
      out.push(JSON.stringify(v));
      return;
  }
  if (Array.isArray(v)) {
    out.push("[");
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(",");
      writeCanonical(v[i], out);
    }
    out.push("]");
    return;
  }
  const keys = Object.keys(v as JsonRecord).sort();
  out.push("{");
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out.push(",");
    out.push(JSON.stringify(keys[i]), ":");
    writeCanonical((v as JsonRecord)[keys[i]], out);
  }
  out.push("}");
}

function canonicalNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER) {
    return String(n);
  }
  if (!Number.isFinite(n)) {
    throw new Error("canonical JSON cannot encode non-finite numbers");
  }
  // Shortest round-trip, exponent notation expanded to plain decimal.
  let s = String(n);
  if (s.includes("e")) {
    const [mantissa, expStr] = s.split("e");
    const exp = Number(expStr);
    const neg = mantissa.startsWith("-");
    let digits = mantissa.replace(/^-/, "").replace(".", "");
    // Position of the decimal point relative to the digit string.
    const pointPos = mantissa.includes(".")
      ? mantissa.indexOf(".") - (neg ? 1 : 0)
      : digits.length;
    const newPoint = pointPos + exp;
    if (newPoint <= 0) {
      digits = "0." + "0".repeat(-newPoint) + digits;
    } else if (newPoint >= digits.length) {
      digits = digits + "0".repeat(newPoint - digits.length);
    } else {
      digits = digits.slice(0, newPoint) + "." + digits.slice(newPoint);
    }
    s = (neg ? "-" : "") + digits;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Distance — the edge / surprise metric
// ---------------------------------------------------------------------------

/**
 * A total metric between JSON values — the ledger's generic `d_mu`:
 * the magnitude of an edge, and the magnitude of a surprise.
 *
 * - numbers: `|a - b|`
 * - equal values (any type): `0`
 * - arrays: mean of element-wise distances; missing elements count 1.0
 * - objects: mean over the key union; missing keys count 1.0
 * - anything else (type mismatch, string vs number, ...): `1.0`
 */
export function valueDistance(a: Json, b: Json): number {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    if (n === 0) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i];
      const y = b[i];
      sum += x === undefined || y === undefined ? 1 : valueDistance(x, y);
    }
    return sum / n;
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (keys.size === 0) return 0;
    let sum = 0;
    for (const k of keys) {
      const x = a[k];
      const y = b[k];
      sum += x === undefined || y === undefined ? 1 : valueDistance(x, y);
    }
    return sum / keys.size;
  }
  if (deepEqual(a, b)) return 0;
  return 1;
}

function isRecord(v: Json): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepEqual(a: Json, b: Json): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export type LedgerOrigin =
  | "System"
  | "Tick"
  | "Call"
  | "Signal"
  | "Dissent"
  | "Gossip";

/** Which engine verb triggered this transaction, plus the caller
 *  chain — the port of quilt-rust `Provenance`. */
export interface Provenance {
  origin: LedgerOrigin;
  caller?: string;
  trace: string[];
}

export const defaultProvenance = (): Provenance => ({
  origin: "System",
  trace: [],
});

export type EntrySide = "Input" | "Output";

/** One side of a double entry. */
export interface Posting {
  side: EntrySide;
  value: Json;
  /** When this side was posted (millis since epoch). */
  ts: number;
}

/** The before→after edge of a transaction — the unit of perception. */
export interface Delta {
  before: Json;
  after: Json;
  changed: boolean;
  /** `valueDistance(before, after)` — the magnitude of the edge. */
  magnitude: number;
}

/**
 * One complete double entry: an input posting, its matching output
 * posting, the state edge it caused, the prediction it was scored
 * against, and its place in the hash chain.
 */
export interface LedgerEntry {
  seq: number;
  ts: number;
  input: Posting;
  output: Posting;
  provenance: Provenance;
  delta: Delta;
  expected?: Json;
  imbalance?: number;
  prev_hash: Hash;
  hash: Hash;
}

/** The result of walking the hash chain and recomputing every seal. */
export interface ChainAudit {
  verified: number;
  intact: boolean;
  first_break?: number;
}

/** Strip optional-none fields the way serde's `skip_serializing_if`
 *  does — the hash preimage must contain them only when set. */
function entryBody(entry: LedgerEntry): Json {
  const body: JsonRecord = {
    seq: entry.seq,
    ts: entry.ts,
    input: postingJson(entry.input),
    output: postingJson(entry.output),
    provenance: provenanceJson(entry.provenance),
    delta: deltaJson(entry.delta),
    prev_hash: entry.prev_hash,
  };
  if (entry.expected !== undefined) body.expected = entry.expected;
  if (entry.imbalance !== undefined) body.imbalance = entry.imbalance;
  return body;
}

function postingJson(p: Posting): Json {
  return { side: p.side, value: p.value, ts: p.ts };
}

function provenanceJson(p: Provenance): Json {
  const out: JsonRecord = { origin: p.origin, trace: p.trace };
  if (p.caller !== undefined) out.caller = p.caller;
  return out;
}

function deltaJson(d: Delta): Json {
  return { before: d.before, after: d.after, changed: d.changed, magnitude: d.magnitude };
}

/** Recompute an entry's seal from its body. Any edit to any hashed
 *  field changes the result — the tamper-evidence check. */
export function sealEntry(entry: LedgerEntry): Hash {
  return sha256Hex(canonicalJson(entryBody(entry)));
}

/** The chain root: commits to cell identity, genesis state, and time.
 *  An empty ledger's head is this commit. */
export function genesisCommit(cellId: string, genesis: Json | null, genesisTs: number | null): Hash {
  return sha256Hex(
    canonicalJson({
      kind: GENESIS_KIND,
      cell_id: cellId,
      genesis: genesis ?? null,
      genesis_ts: genesisTs,
    }),
  );
}

// ---------------------------------------------------------------------------
// Verification (standalone — used by the gossip layer on received
// journals, exactly like the firmware refuses a bad receipt)
// ---------------------------------------------------------------------------

/**
 * Verify a sequence of entries as a chain rooted at `genesisCommit`:
 * seq continuity from 1, every prev-link, and every seal recomputed.
 * Returns how many entries verified intact and where the first break
 * is. This is the inclusion check a boat runs on a peer's journal
 * before trusting a single byte of it.
 */
export function verifyChain(
  cellId: string,
  genesis: Json | null,
  genesisTs: number | null,
  entries: LedgerEntry[],
): ChainAudit {
  let expectedPrev = genesisCommit(cellId, genesis, genesisTs);
  for (const entry of entries) {
    if (entry.prev_hash !== expectedPrev || entry.hash !== sealEntry(entry)) {
      return {
        verified: entry.seq - 1,
        intact: false,
        first_break: entry.seq,
      };
    }
    expectedPrev = entry.hash;
  }
  return { verified: entries.length, intact: true };
}

// ---------------------------------------------------------------------------
// The ledger itself
// ---------------------------------------------------------------------------

/** An input posted (debit) but not yet answered (credit). */
export interface PendingInput {
  ticket: number;
  ts: number;
  input: Json;
  provenance: Provenance;
}

export class CellLedger {
  readonly cellId: string;
  genesis: Json | null;
  genesisTs: number | null;
  /** The cell's current state (the `after` of the last entry, or the
   *  genesis, or null). */
  state: Json;
  private nextSeq = 1;
  private nextTicket = 1;
  entries: LedgerEntry[] = [];
  pending: PendingInput[] = [];

  constructor(cellId: string) {
    this.cellId = cellId;
    this.genesis = null;
    this.genesisTs = null;
    this.state = null;
  }

  static withGenesis(cellId: string, genesis: Json, ts: number): CellLedger {
    const ledger = new CellLedger(cellId);
    ledger.genesis = genesis;
    ledger.genesisTs = ts;
    ledger.state = genesis;
    return ledger;
  }

  /** Number of completed entries. */
  get length(): number {
    return this.entries.length;
  }

  /** The head of the chain: the last entry's hash, or the genesis
   *  commit for an empty ledger. Commits to the cell's identity, its
   *  initial state, and every transaction it ever recorded. */
  chainHash(): Hash {
    return this.entries.length > 0
      ? this.entries[this.entries.length - 1].hash
      : genesisCommit(this.cellId, this.genesis, this.genesisTs);
  }

  /** Record a complete double entry: input in, output out, at `ts`,
   *  system provenance, persistence prediction. */
  record(input: Json, output: Json, ts: number): LedgerEntry {
    return this.recordWith(input, output, ts, defaultProvenance(), undefined);
  }

  /** `record` with full control over provenance and prediction. The
   *  forecast is hashed into the entry — predictions cannot be
   *  rewritten after the fact. */
  recordWith(
    input: Json,
    output: Json,
    ts: number,
    provenance: Provenance,
    expected: Json | undefined,
  ): LedgerEntry {
    return this.appendEntry(input, ts, output, ts, provenance, expected);
  }

  /** Post a debit without its credit. Returns the open ticket. */
  openInput(input: Json, ts: number, provenance: Provenance = defaultProvenance()): number {
    const ticket = this.nextTicket++;
    this.pending.push({ ticket, ts, input, provenance });
    return ticket;
  }

  /** Close a ticket with the credit side, sealing the double entry. */
  settleOutput(ticket: number, output: Json, ts: number): LedgerEntry {
    const idx = this.pending.findIndex((p) => p.ticket === ticket);
    if (idx === -1) throw new Error(`no such ticket: ${ticket}`);
    const p = this.pending[idx];
    this.pending.splice(idx, 1);
    return this.appendEntry(
      p.input,
      p.ts,
      output,
      ts,
      p.provenance,
      undefined,
    );
  }

  private appendEntry(
    input: Json,
    inputTs: number,
    output: Json,
    outputTs: number,
    provenance: Provenance,
    expected: Json | undefined,
  ): LedgerEntry {
    const before = this.state;
    const after = output;
    const delta = {
      before,
      after,
      changed: !deepEqual(before ?? null, after),
      magnitude: valueDistance(before ?? null, after),
    };

    // A prior exists if the cell had a genesis or has already
    // completed an entry. Without one, no surprise is claimed.
    const hasPrior = this.genesis !== null || this.entries.length > 0;
    let recordedExpected: Json | undefined;
    let imbalance: number | undefined;
    if (expected !== undefined) {
      recordedExpected = expected;
      imbalance = valueDistance(expected, after);
    } else if (hasPrior) {
      recordedExpected = before;
      imbalance = delta.magnitude;
    }

    const entry: LedgerEntry = {
      seq: this.nextSeq++,
      ts: inputTs,
      input: { side: "Input", value: input, ts: inputTs },
      output: { side: "Output", value: output, ts: outputTs },
      provenance,
      delta,
      ...(recordedExpected !== undefined ? { expected: recordedExpected } : {}),
      ...(imbalance !== undefined ? { imbalance } : {}),
      prev_hash: this.chainHash(),
      hash: "",
    };
    entry.hash = sealEntry(entry);
    this.entries.push(entry);
    this.state = after;
    return entry;
  }

  /** Recompute every seal and every prev-link. */
  verifyChain(): ChainAudit {
    return verifyChain(this.cellId, this.genesis, this.genesisTs, this.entries);
  }

  /** Serialize for the wire / disk. The `genesis` fields ride along so
   *  a receiver can recompute the chain root and verify. */
  toJournalJson(): JournalJson {
    return {
      cell_id: this.cellId,
      genesis: this.genesis ?? null,
      genesis_ts: this.genesisTs,
      entries: this.entries,
    };
  }

  /** Rehydrate a ledger from a journal, verifying first. Throws if the
   *  chain does not verify — a boat never adopts a journal it cannot
   *  prove. */
  static fromJournalJson(j: JournalJson): CellLedger {
    const audit = verifyChain(j.cell_id, j.genesis, j.genesis_ts, j.entries);
    if (!audit.intact) {
      throw new Error(
        `journal for ${j.cell_id} does not verify (first break at seq ${audit.first_break})`,
      );
    }
    const ledger = j.genesis !== null && j.genesis_ts !== null
      ? CellLedger.withGenesis(j.cell_id, j.genesis, j.genesis_ts)
      : new CellLedger(j.cell_id);
    ledger.entries = [...j.entries];
    ledger.nextSeq = j.entries.length + 1;
    ledger.state =
      j.entries.length > 0 ? j.entries[j.entries.length - 1].delta.after : (j.genesis ?? null);
    return ledger;
  }
}

/** The serializable journal artifact — what travels over the wire and
 *  what a mint receipt is taken over. */
export interface JournalJson {
  cell_id: string;
  genesis: Json | null;
  genesis_ts: number | null;
  entries: LedgerEntry[];
}
