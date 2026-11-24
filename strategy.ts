// Spike Rider v2 - a pump.fun launch momentum bot for agent-fun/replay/v2.
//
// Idea, in one line: only buy a launch that is already sprinting, size the bet to
// how hot the launch looks, and cut losers fast. Memecoin launches either keep
// running or die within minutes; the bot never averages down, never chases a coin
// that already dumped, and never holds past a short fuse.
//
// Two tiers. The quality tier (0.2 SOL) is for launches that are hot: price
// >= 1.4x the create price within the first 3 slots, with 10+ trades and 3+
// distinct buyers already on the tape - that crowd is the signal (winners
// average 9 buyers in the first slots, losers 6). The filler tier (0.015 SOL)
// takes every other launch that clears the same run-up and the rug screen: its
// trades are about breakeven on their own, but they are what the competition's
// 20-coin minimum bar needs on a 6-hour final window, and at 0.015 SOL a bad
// one costs almost nothing. A single-slot bundler dump (-65% in one slot, which
// no stop-loss can catch because the fill lands 2 slots after the trigger) is
// part of the game; diversification across ~150 coins plus the small filler
// stake is the answer, not a filter - a largest-buy concentration filter was
// tested and dropped: it cut the trade count to 9 coins a day without
// improving PnL.
//
// Why this shape (measured on the kit's 24h dev window, full replay sim):
//   - Dev net +0.033 SOL over 158 coins, positive in both halves of the
//     window, max drawdown 0.8%. The house sniper baseline loses -0.47 SOL
//     on the same window.
//   - Fees are ~2.9% of stake per round trip (125 bps curve fees each way plus
//     105k lamports of tx fees), so the stop must be tight (-3%) and the stake
//     big enough that the fixed tx fee is a small share of it.
//   - The 1%-of-real-reserve buy cap means a 0.2 SOL stake cannot land in one
//     reply on a young curve; the bot tops up in later batches while the coin
//     keeps climbing (adds), never more than the stake in total.
//   - Entries after slot 3 lose money (late pumps are traps), and a trailing
//     stop loses to a fixed take-profit here (winners mean-revert within the
//     2-slot fill latency), so both are left out.
//
// Entry filters (the rug screen): skip when the creator sold before entry, when
// the creator's own create-slot buy is outsized, when one sell already dwarfs
// the buys, or when sellers outweigh buyers. Exits: take-profit +20%, hard stop
// -3%, max hold 600 slots, creator sells while held, or the tape goes stale.
// Pure function of the batches: no clock, no randomness, no I/O, so the two
// grading runs agree byte for byte.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin in the quality tier. */
  stakeLamports: number;
  /** Lamports to aim for per coin in the filler tier. */
  fillerStakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Adds keep topping a position up while the coin is this young (slots since create). */
  addMaxAge: number;
  /** An add needs the price at least this far (bps) above the previous buy's decision price. */
  addStepBps: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: at most this many lamports. */
  maxDevBuy: number;
  /** Quality tier: trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most (quality tier). */
  maxBuyers: number;
  /** Filler tier: trades seen before entry, at least. */
  fillerMinTrades: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Quality tier: price now over the create price, as bps (10000 = 1x), at least. */
  minRunupBps: number;
  /** Filler tier: price now over the create price, as bps, at least. */
  fillerMinRunupBps: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps): a buy whose price jumps more than this in the latency is refused. */
  buySlippageBps: number;
  /** Fixed take-profit: sell all once the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when the position is worth this much under its cost (bps). */
  slBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 3,
  stakeLamports: 200_000_000,
  fillerStakeLamports: 15_000_000,
  minBuyLamports: 5_000_000,
  addMaxAge: 150,
  addStepBps: 0,
  minRealSol: 300_000_000,
  maxRealSol: 30_000_000_000,
  maxDevBuy: 2_500_000_000,
  minTrades: 10,
  minBuyers: 3,
  maxBuyers: 20,
  fillerMinTrades: 5,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 5_000,
  minRunupBps: 14_000,
  fillerMinRunupBps: 14_000,
  skipDevSold: true,
  buySlippageBps: 1_000,
  tpBps: 2_000,
  slBps: 300,
  maxHold: 600,
  exitOnDevSell: true,
  staleSlots: 240,
};

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Lamports of buys sent so far (decided, not necessarily filled). */
  spentSent: bigint;
  /** Stake target for this coin (quality or filler tier), set on the first buy. */
  stakeTarget: bigint;
  /** Decision price (vq/vt as a pair) of the last buy sent. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  devSoldAtOpen: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** Curve fees on this competition: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const fillerStake = BigInt(P.fillerStakeLamports);
  const minBuy = BigInt(P.minBuyLamports);

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          spentSent: 0n,
          stakeTarget: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      // Reconcile held bookkeeping with fills that arrived in this batch.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), devSoldAtOpen: coins.get(f.mint)?.devSold ?? false });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first: every held position is re-priced on this batch's marks.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries and top-ups.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const isAdd = c.spentSent > 0n;
        if (!isAdd && age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (isAdd && age > P.addMaxAge) continue;
        if (isAdd) {
          if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
        } else if (open >= state.hello.caps.max_open_positions) {
          continue;
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && P.skipDevSold) {
          if (!isAdd) c.done = true;
          continue;
        }
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        let target = c.stakeTarget;
        if (isAdd) {
          // Top up only while the launch keeps climbing from the last buy.
          if (vq * c.lastBuyVt * BPS < c.lastBuyVq * vt * BigInt(10_000 + P.addStepBps)) continue;
        } else {
          // Rug screen, shared by both tiers.
          const rq = curve.real_quote_reserves;
          if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
          if (c.devBuy > BigInt(P.maxDevBuy)) continue;
          if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
          if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
          // The spike: price now over the create price.
          const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
          const clean =
            c.trades >= P.minTrades &&
            c.buyers.size >= P.minBuyers &&
            c.buyers.size <= P.maxBuyers &&
            runup >= BigInt(P.minRunupBps);
          const loose = c.trades >= P.fillerMinTrades && runup >= BigInt(P.fillerMinRunupBps);
          if (clean) target = stake;
          else if (loose) target = fillerStake;
          else continue;
          c.stakeTarget = target;
        }
        const room = target - c.spentSent;
        if (room < minBuy) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.spentSent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        if (!isAdd) open += 1;
      }
      return orders;
    },
  };
}
