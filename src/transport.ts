// src/transport.ts
/**
 * Pluggable transports for the gossip layer.
 *
 * The interface is deliberately UDP-shaped: `send` is fire-and-forget
 * (no reply, no delivery guarantee at the transport level), and
 * delivery happens by polling an inbound queue. Reliability lives in
 * the protocol — the next gossip round re-exchanges digests and
 * re-pulls anything that was lost. That is the honest, SWIM-style
 * way: cheap lossy pings, anti-entropy doing the heavy lifting.
 *
 * Three real implementations:
 *  - InMemoryTransport — a mail hub in one process; tests use it, and
 *    it can simulate partitions (drop traffic between sets of nodes).
 *  - DirTransport — every boat has an inbox directory in a shared
 *    "harbor"; messages are JSON files written atomically (tmp +
 *    rename) and consumed on poll. For CI and demo runs.
 *  - UdpTransport — real datagrams (node:dgram), with chunked
 *    reassembly for payloads larger than one datagram. For real
 *    boats on a LAN.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, basename } from "node:path";
import { createSocket, type Socket } from "node:dgram";

// ---------------------------------------------------------------------------
// Wire envelope — everything a transport carries
// ---------------------------------------------------------------------------

/** One boat's want-list entry. */
export interface Want {
  cell_id: string;
  /** Pull entries with seq > from_seq (0 = the whole journal). */
  from_seq: number;
}

/** A journal delivery: the artifact plus the mint receipt packet it
 *  claims to satisfy. The receiver verifies both before adopting. */
export interface JournalDelivery {
  packet: {
    boat_id: string;
    cell_id: string;
    receipt_sha: string;
    chain_head: string;
    ts: number;
    tier: string;
  };
  journal: {
    cell_id: string;
    genesis: unknown;
    genesis_ts: number | null;
    entries: unknown[];
  };
}

export interface Envelope {
  kind: "digest" | "pull" | "journals";
  from: string;
  /** How to reach the sender back (transport-specific address). */
  from_addr: string;
  msg_id: string;
  ts: number;
  /** Membership gossip: a sample of peers the sender knows. */
  peers?: string[];
  /** kind === "digest": mint receipts for every journal the sender
   *  holds — one packet per cell. */
  packets?: JournalDelivery["packet"][];
  /** kind === "pull": what the sender is missing. */
  want?: Want[];
  /** kind === "journals": the pulled artifacts. */
  journals?: JournalDelivery[];
}

export type Handler = (env: Envelope) => void;

export interface Transport {
  readonly kind: "memory" | "dir" | "udp";
  /** Our boat id. */
  readonly self: string;
  /** Our reachable address, as other boats see it. */
  addr(): string;
  /** Fire-and-forget send. */
  send(to: string, env: Envelope): void;
  /** Drain the inbound queue once, invoking `handler` per message. */
  poll(handler: Handler): void;
  /** Known peer addresses (not including self). */
  discover(): string[];
  /** Announce presence (dir manifests; no-op elsewhere). */
  presence(packets: JournalDelivery["packet"][]): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// In-memory hub — tests, single-process demos, partition simulation
// ---------------------------------------------------------------------------

export class MailHub {
  private mailboxes = new Map<string, Envelope[]>();
  /** If set, traffic between the two groups is dropped both ways. */
  private dropRule: { a: Set<string>; b: Set<string> } | null = null;

  register(id: string): void {
    if (!this.mailboxes.has(id)) this.mailboxes.set(id, []);
  }

  ids(): string[] {
    return [...this.mailboxes.keys()];
  }

  deliver(to: string, env: Envelope): void {
    const box = this.mailboxes.get(to);
    if (!box) return; // unknown boat: dropped, like a bad datagram
    if (this.dropped(env.from, to)) return;
    box.push(env);
  }

  drain(id: string): Envelope[] {
    const box = this.mailboxes.get(id) ?? [];
    const out = [...box];
    box.length = 0;
    return out;
  }

  /** Partition: traffic between group A and group B is dropped. */
  partition(a: string[], b: string[]): void {
    this.dropRule = { a: new Set(a), b: new Set(b) };
  }

  heal(): void {
    this.dropRule = null;
  }

  private dropped(from: string, to: string): boolean {
    const r = this.dropRule;
    if (!r) return false;
    const fromA = r.a.has(from), toA = r.a.has(to);
    const fromB = r.b.has(from), toB = r.b.has(to);
    return (fromA && toB) || (fromB && toA);
  }
}

export class InMemoryTransport implements Transport {
  readonly kind = "memory" as const;
  constructor(readonly self: string, private hub: MailHub) {
    this.hub.register(self);
  }
  addr(): string {
    return `mem://${this.self}`;
  }
  send(to: string, env: Envelope): void {
    // A boat's mem address is "mem://<id>"; also accept bare ids.
    const id = to.replace(/^mem:\/\//, "");
    this.hub.deliver(id, env);
  }
  poll(handler: Handler): void {
    for (const env of this.hub.drain(this.self)) handler(env);
  }
  discover(): string[] {
    return this.hub
      .ids()
      .filter((id) => id !== this.self)
      .map((id) => `mem://${id}`);
  }
  presence(): void {
    /* manifests are a dir-transport concept */
  }
  close(): void {
    /* nothing held */
  }
}

// ---------------------------------------------------------------------------
// Directory transport — a shared "harbor" of inboxes and manifests
// ---------------------------------------------------------------------------

export class DirTransport implements Transport {
  readonly kind = "dir" as const;
  private counter = 0;
  private readonly inboxDir: string;
  private readonly manifestPath: string;

  constructor(readonly self: string, private readonly root: string) {
    this.inboxDir = join(root, "inbox", self);
    mkdirSync(this.inboxDir, { recursive: true });
    this.manifestPath = join(root, "nodes", `${self}.json`);
    mkdirSync(join(root, "nodes"), { recursive: true });
  }

  addr(): string {
    return `dir://${this.root}`;
  }

  /** Peer addresses in a dir harbor are just boat ids: every inbox is
   *  <root>/inbox/<id>. */
  send(to: string, env: Envelope): void {
    const id = to.replace(/^dir:\/\//, "");
    const dir = join(this.root, "inbox", id);
    mkdirSync(dir, { recursive: true });
    const seq = String(++this.counter).padStart(8, "0");
    const final = join(dir, `${seq}-${env.msg_id}.json`);
    const tmp = `${final}.tmp`;
    writeFileSync(tmp, JSON.stringify(env));
    renameSync(tmp, final); // atomic: receivers never see half a message
  }

  poll(handler: Handler): void {
    if (!existsSync(this.inboxDir)) return;
    const files = readdirSync(this.inboxDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files) {
      const path = join(this.inboxDir, f);
      try {
        const env = JSON.parse(readFileSync(path, "utf8")) as Envelope;
        unlinkSync(path); // consume the mail
        handler(env);
      } catch {
        // A torn or foreign file: remove it; gossip is idempotent.
        try {
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      }
    }
  }

  /** Peer ids, from live manifests (heartbeat within stalenessMs). */
  discover(stalenessMs = 15_000): string[] {
    const dir = join(this.root, "nodes");
    if (!existsSync(dir)) return [];
    const now = Date.now();
    const peers: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const id = basename(f, ".json");
      if (id === this.self) continue;
      try {
        const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
          last_seen: number;
        };
        if (now - m.last_seen <= stalenessMs) peers.push(id);
      } catch {
        /* unreadable manifest: skip */
      }
    }
    return peers;
  }

  presence(packets: JournalDelivery["packet"][]): void {
    const manifest = {
      id: this.self,
      addr: this.addr(),
      tier: packets[0]?.tier ?? null,
      cells: Object.fromEntries(
        packets.map((p) => [p.cell_id, { head: p.chain_head, len_hint: p.receipt_sha }]),
      ),
      packets,
      last_seen: Date.now(),
    };
    const tmp = `${this.manifestPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(manifest));
    renameSync(tmp, this.manifestPath);
  }

  close(): void {
    /* the harbor outlives any single boat */
  }
}

// ---------------------------------------------------------------------------
// UDP — real datagrams, chunked for payloads over one packet
// ---------------------------------------------------------------------------

const MAX_CHUNK = 1200; // bytes of payload per datagram (safe for LAN MTU)

interface ChunkMsg {
  msg_id: string;
  n: number; // total chunks
  i: number; // this chunk's index
  part: string; // base payload slice
}

export class UdpTransport implements Transport {
  readonly kind = "udp" as const;
  private socket: Socket;
  private reassembly = new Map<string, ChunkMsg[]>();
  private seeds = new Set<string>();
  private learned = new Set<string>();
  private inbox: Envelope[] = [];

  constructor(readonly self: string, port: number, seeds: string[] = []) {
    this.socket = createSocket("udp4");
    this.socket.bind(port);
    this.socket.on("message", (buf) => this.onDatagram(buf));
    for (const s of seeds) this.seeds.add(s);
  }

  addr(): string {
    const a = this.socket.address();
    return `${a.address === "0.0.0.0" ? "127.0.0.1" : a.address}:${a.port}`;
  }

  send(to: string, env: Envelope): void {
    const [host, portStr] = to.split(":");
    const port = Number(portStr);
    if (!host || !port) return;
    const payload = Buffer.from(JSON.stringify(env), "utf8");
    // Small enough: one datagram. Large: numbered chunks.
    if (payload.length <= MAX_CHUNK) {
      this.socket.send(payload, port, host);
      return;
    }
    const n = Math.ceil(payload.length / MAX_CHUNK);
    for (let i = 0; i < n; i++) {
      const chunk: ChunkMsg = {
        msg_id: env.msg_id,
        n,
        i,
        part: payload.subarray(i * MAX_CHUNK, (i + 1) * MAX_CHUNK).toString("utf8"),
      };
      this.socket.send(Buffer.from(JSON.stringify(chunk), "utf8"), port, host);
    }
  }

  private onDatagram(buf: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch {
      return; // garbage datagram: dropped
    }
    // A chunk frame or a whole envelope?
    const maybeChunk = parsed as Partial<ChunkMsg>;
    if (typeof maybeChunk.msg_id === "string" && typeof maybeChunk.n === "number") {
      const key = maybeChunk.msg_id;
      let parts = this.reassembly.get(key) ?? [];
      parts.push(maybeChunk as ChunkMsg);
      if (parts.length >= (maybeChunk.n ?? Infinity)) {
        parts = parts.sort((x, y) => x.i - y.i);
        const joined = parts.map((p) => p.part).join("");
        this.reassembly.delete(key);
        try {
          this.inbox.push(JSON.parse(joined) as Envelope);
        } catch {
          /* corrupt reassembly: drop; the next round retries */
        }
      } else {
        this.reassembly.set(key, parts);
      }
      return;
    }
    const env = parsed as Envelope;
    if (env && typeof env.from === "string" && env.from_addr) {
      this.learned.add(env.from_addr); // membership gossip
    }
    this.inbox.push(env);
  }

  poll(handler: Handler): void {
    const drained = this.inbox;
    this.inbox = [];
    for (const env of drained) handler(env);
  }

  discover(): string[] {
    const all = [...this.seeds, ...this.learned];
    const me = this.addr();
    return [...new Set(all)].filter((a) => a !== me);
  }

  presence(): void {
    /* UDP discovery travels inside the envelopes (peers field) */
  }

  /** Teach the transport a peer explicitly (CLI --peer). */
  addSeed(addr: string): void {
    this.seeds.add(addr);
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// Transport URL parsing
// ---------------------------------------------------------------------------

export function makeTransport(
  url: string,
  self: string,
  opts: { seeds?: string[]; hub?: MailHub } = {},
): Transport {
  if (url.startsWith("mem://")) {
    return new InMemoryTransport(self, opts.hub ?? sharedHub);
  }
  if (url.startsWith("dir://")) {
    return new DirTransport(self, url.slice("dir://".length));
  }
  if (url.startsWith("udp://")) {
    const port = Number(url.slice("udp://".length).split(":")[0] || 0);
    return new UdpTransport(self, port, opts.seeds ?? []);
  }
  throw new Error(`unknown transport url: ${url} (want mem:// | dir:// | udp://)`);
}

/** Default hub for mem:// when none is provided (single-process use). */
export const sharedHub = new MailHub();

export { rmSync };
