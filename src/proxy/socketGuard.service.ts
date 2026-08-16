import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Socket } from 'net';

/**
 * Reaps proxied socket pairs that stop moving bytes, so the kernel can never again pin
 * unbounded Winsock buffers on this box (task-1556).
 *
 * The failure this exists to prevent: on 2026-08-16 the box hit 123/127.5 GB RAM while every
 * process working set summed to only 54 GB. The missing 54 GB was kernel NONPAGED POOL under the
 * `AfdB` tag — afd.sys socket buffers. The Phone Sync server on 127.0.0.1:7071 had been replaced,
 * and this proxy still held 257 upstream loopback connections to the dead instance. Each pair had
 * around 210 MB of stream data sitting in kernel buffers that nobody was ever going to read: the
 * proxy had stopped reading the upstream (its client was gone), and the dead upstream sat in
 * FinWait1 unable to flush. Loopback TCP windows grow effectively without bound, so the only thing
 * limiting the damage was how many connections accumulated. Restarting the proxy freed all 54 GB at
 * once (nonpaged 56.9 -> 2.7 GB), which is proof the proxy was the one holding them.
 *
 * Node cannot cap the kernel's per-socket buffering (there is no SO_RCVBUF binding), so the bound
 * has to be time: a socket pair that is not moving bytes is not doing work, and is destroyed.
 * Three independent mechanisms, cheapest first:
 *
 *   1. TCP keepalive on both halves, so a peer that vanished without an RST is reset by the stack
 *      in about a minute instead of Windows' two-hour default.
 *   2. A STALL reaper: bytes are not moving AND one side is holding buffered data the other side is
 *      not draining. That is exactly the leak's signature and gets the short timeout.
 *   3. An IDLE reaper: no bytes in either direction for a long window. This is the backstop for a
 *      pair that is simply abandoned, and gets a deliberately generous timeout so a legitimately
 *      quiet SSE or WebSocket stream is never cut.
 *
 * Activity is measured by polling `bytesRead`/`bytesWritten` on a single shared sweep timer rather
 * than by listening for 'data'. Attaching a 'data' listener would put a paused socket into flowing
 * mode and destroy the backpressure that makes streaming correct; reading the counters changes
 * nothing about the stream.
 */

/** Tunables, env-overridable so a live box can be adjusted without a rebuild. */
export interface SocketGuardConfig {
  /** TCP keepalive idle delay in ms. 0 disables keepalive. */
  keepAliveMs: number;
  /** No bytes in either direction for this long destroys the pair. 0 disables the idle reaper. */
  idleTimeoutMs: number;
  /** Buffered-but-not-draining for this long destroys the pair. 0 disables the stall reaper. */
  stallTimeoutMs: number;
  /** How much unwritten data counts as "buffered" for the stall reaper. */
  stallBufferedBytes: number;
  /** How often every tracked pair is checked. */
  sweepIntervalMs: number;
}

/** One proxied client<->upstream pair while it is in flight. */
interface TrackedPair {
  /** Short description used in the reap log line, e.g. `ws phone.jasonmcaffee.com`. */
  label: string;
  startedAt: number;
  client?: Socket;
  upstream?: Socket;
  /** Sum of bytesRead+bytesWritten across both halves at the last sweep. */
  lastBytes: number;
  /** When that sum last changed. */
  lastMovedAt: number;
  /** When the pair first looked stalled (buffered data, no movement), or null. */
  stalledSince: number | null;
}

/** Why a pair was destroyed, for the counters and the log line. */
type ReapReason = 'idle' | 'stalled';

/**
 * Reads the guard's tuning from the environment, falling back to values chosen for this box.
 *
 * The idle window is 15 minutes because the streams that legitimately go quiet here are chat SSE
 * and socket.io tunnels, both of which produce traffic (tokens, pings) far more often than that.
 * The stall window is 2 minutes because a pair with buffered data that is draining nothing for two
 * minutes is not a slow client — a slow client still drains *some* bytes every sweep.
 */
export function loadSocketGuardConfig(): SocketGuardConfig {
  return {
    keepAliveMs: readMs('PROXY_SOCKET_KEEPALIVE_MS', 60_000),
    idleTimeoutMs: readMs('PROXY_SOCKET_IDLE_TIMEOUT_MS', 900_000),
    stallTimeoutMs: readMs('PROXY_SOCKET_STALL_TIMEOUT_MS', 120_000),
    stallBufferedBytes: readMs('PROXY_SOCKET_STALL_BUFFERED_BYTES', 64 * 1024),
    sweepIntervalMs: readMs('PROXY_SOCKET_SWEEP_INTERVAL_MS', 15_000),
  };
}

/**
 * Parses a non-negative integer environment variable, falling back when unset or malformed.
 * @param name - environment variable to read
 * @param fallback - value used when the variable is absent or not a non-negative integer
 */
function readMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

@Injectable()
export class SocketGuardService implements OnModuleDestroy {
  private readonly logger = new Logger('ProxySockets');
  private readonly config = loadSocketGuardConfig();
  private readonly tracked = new Set<TrackedPair>();
  private readonly sweepTimer: NodeJS.Timeout;
  private trackedTotal = 0;
  private reapedIdle = 0;
  private reapedStalled = 0;
  /** Peak number of pairs in flight at once, which is what runaway accumulation looks like. */
  private peakTracked = 0;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweep(), this.config.sweepIntervalMs);
    this.sweepTimer.unref?.();
    this.logger.log(
      `socket guard active: keepalive=${this.config.keepAliveMs}ms idle=${this.config.idleTimeoutMs}ms ` +
        `stall=${this.config.stallTimeoutMs}ms sweep=${this.config.sweepIntervalMs}ms`,
    );
  }

  onModuleDestroy() {
    clearInterval(this.sweepTimer);
  }

  /**
   * Turns on TCP keepalive and disables Nagle on a socket the proxy owns.
   *
   * Keepalive is the only mechanism that recovers a peer which disappeared without sending an RST
   * (a phone that left the network, a machine that was powered off). Windows' default keepalive
   * idle is two hours, which is long enough for hundreds of dead pairs to pile up first.
   * @param socket - the socket to harden, if it still exists
   */
  harden(socket?: Socket | null) {
    if (!socket || socket.destroyed) return;
    try {
      socket.setNoDelay(true);
      if (this.config.keepAliveMs > 0) socket.setKeepAlive(true, this.config.keepAliveMs);
    } catch {
      // A socket can be torn down between the caller's check and here; nothing to recover.
    }
  }

  /**
   * Starts watching a proxied pair and returns the handle used to complete and end that watch.
   *
   * The upstream half is usually not known yet at call time (an HTTP proxy request has no socket
   * until the agent assigns one), so the handle carries an `attachUpstream` for when it arrives,
   * and a `release` for when the exchange is over.
   * @param label - short description used in log lines
   * @param client - the downstream client socket, when it is already known
   */
  track(label: string, client?: Socket): TrackedHandle {
    const pair: TrackedPair = {
      label,
      startedAt: Date.now(),
      client,
      lastBytes: countBytes(client, undefined),
      lastMovedAt: Date.now(),
      stalledSince: null,
    };
    this.harden(client);
    this.tracked.add(pair);
    this.trackedTotal++;
    if (this.tracked.size > this.peakTracked) this.peakTracked = this.tracked.size;

    return {
      attachUpstream: (upstream?: Socket | null) => {
        if (!upstream) return;
        pair.upstream = upstream;
        this.harden(upstream);
      },
      release: () => {
        this.tracked.delete(pair);
      },
    };
  }

  /** Snapshot of guard activity, served by the proxy's socket-stats endpoint. */
  stats() {
    const now = Date.now();
    const inFlight = [...this.tracked];
    return {
      config: this.config,
      trackedNow: inFlight.length,
      trackedTotal: this.trackedTotal,
      peakTracked: this.peakTracked,
      reapedIdle: this.reapedIdle,
      reapedStalled: this.reapedStalled,
      /** The pairs that have been open longest — the ones an accumulation would show up in. */
      oldest: inFlight
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(0, 10)
        .map((pair) => ({
          label: pair.label,
          ageMs: now - pair.startedAt,
          idleMs: now - pair.lastMovedAt,
          bufferedBytes: bufferedBytes(pair),
        })),
    };
  }

  /**
   * Checks every tracked pair once, destroying the ones that are stalled or idle.
   *
   * Runs on a single shared timer rather than one timer per connection so that thousands of
   * in-flight streams cost one wakeup, not thousands.
   */
  private sweep() {
    const now = Date.now();
    for (const pair of this.tracked) {
      if (isFinished(pair)) {
        this.tracked.delete(pair);
        continue;
      }

      const bytes = countBytes(pair.client, pair.upstream);
      if (bytes !== pair.lastBytes) {
        pair.lastBytes = bytes;
        pair.lastMovedAt = now;
        pair.stalledSince = null;
        continue;
      }

      // Nothing moved. If one half is sitting on data the other half is not taking, this is the
      // leak's exact signature and gets the short timeout.
      if (this.config.stallTimeoutMs > 0 && bufferedBytes(pair) >= this.config.stallBufferedBytes) {
        pair.stalledSince ??= now;
        if (now - pair.stalledSince >= this.config.stallTimeoutMs) {
          this.reap(pair, 'stalled', now);
          continue;
        }
      }

      if (this.config.idleTimeoutMs > 0 && now - pair.lastMovedAt >= this.config.idleTimeoutMs) {
        this.reap(pair, 'idle', now);
      }
    }
  }

  /**
   * Destroys both halves of a pair and records why, so the freed buffers are attributable.
   * @param pair - the pair being torn down
   * @param reason - which reaper fired
   * @param now - the sweep's timestamp, so every line in one sweep agrees
   */
  private reap(pair: TrackedPair, reason: ReapReason, now: number) {
    this.tracked.delete(pair);
    if (reason === 'idle') this.reapedIdle++;
    else this.reapedStalled++;

    const buffered = bufferedBytes(pair);
    this.logger.warn(
      `reaped ${reason} stream ${pair.label} after ${Math.round((now - pair.startedAt) / 1000)}s ` +
        `(idle ${Math.round((now - pair.lastMovedAt) / 1000)}s, ${buffered} bytes buffered)`,
    );

    reset(pair.client);
    reset(pair.upstream);
  }
}

/** Handle returned by `track`, used to attach the upstream half and to stop watching. */
export interface TrackedHandle {
  attachUpstream: (upstream?: Socket | null) => void;
  release: () => void;
}

/**
 * Destroys both halves of a tunnel as soon as either half closes, so neither can linger half-open
 * accumulating data the other end will never read.
 * @param a - one half of the tunnel
 * @param b - the other half
 */
export function linkSocketLifetimes(a: Socket, b: Socket) {
  const teardown = () => {
    destroy(a);
    destroy(b);
  };
  a.once('close', teardown);
  b.once('close', teardown);
  a.once('end', teardown);
  b.once('end', teardown);
}

/** Destroys a socket if it still exists and has not already been torn down. */
function destroy(socket?: Socket | null) {
  if (socket && !socket.destroyed) socket.destroy();
}

/**
 * Tears a reaped socket down abortively (RST) rather than gracefully (FIN).
 *
 * This matters for what the guard is for. A plain `destroy()` sends a FIN, which leaves the peer
 * half-open in CLOSE_WAIT until its application gets around to closing, and leaves whatever is
 * queued to be flushed. An RST ends the conversation immediately and lets the kernel drop both
 * sides' buffers on the spot — which is the entire point of reaping a stream nobody is reading.
 * A graceful close is still the right thing everywhere else, so this is used only by the reaper.
 * @param socket - the socket to reset, if it still exists
 */
function reset(socket?: Socket | null) {
  if (!socket || socket.destroyed) return;
  // resetAndDestroy landed in Node 18.3; fall back rather than assume the runtime.
  if (typeof (socket as any).resetAndDestroy === 'function') (socket as any).resetAndDestroy();
  else socket.destroy();
}

/** True once neither half of a pair is still a live socket. */
function isFinished(pair: TrackedPair): boolean {
  const clientDone = !pair.client || pair.client.destroyed;
  const upstreamDone = !pair.upstream || pair.upstream.destroyed;
  return clientDone && upstreamDone;
}

/**
 * Total bytes that have crossed either half of the pair in either direction.
 * A change in this number between sweeps is the definition of "this stream is doing work".
 * @param client - the downstream socket, if known
 * @param upstream - the upstream socket, if known
 */
function countBytes(client?: Socket, upstream?: Socket): number {
  return (
    (client?.bytesRead ?? 0) +
    (client?.bytesWritten ?? 0) +
    (upstream?.bytesRead ?? 0) +
    (upstream?.bytesWritten ?? 0)
  );
}

/** Bytes queued in Node for writing on either half — the visible part of a backed-up stream. */
function bufferedBytes(pair: TrackedPair): number {
  return (pair.client?.writableLength ?? 0) + (pair.upstream?.writableLength ?? 0);
}
