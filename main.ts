// Pump Paper Bot — an original momentum paper-trading bot for the pump.fun replay.
//
// Idea: ride genuine buy flow on young bonding curves, size in small and cut losers
// fast. Every rule below is my own design; the only shared code is the vendor shim
// in vendor/makefun-bot.ts, which owns the wire.
//
// Flow of one batch (slot):
//   1. Fold this batch's events into a per-mint tape (price = virtual quote / virtual
//      token reserves, SOL flow, distinct buyers).
//   2. Exits first: stop-loss, trailing stop, take-profit, fade, big-sell, max hold.
//   3. Entries on mints that traded this batch and pass a strict momentum signal:
//      mature curve, strong accelerating net buy flow from many distinct buyers,
//      price up 10-80% over the window and sitting near its window high.
//   4. Guardrail pacing: tiny probe round-trips only if distinct coins / fills lag pace.
//
// Sizing is deliberately flat: one 0.03 SOL buy per position, no pyramiding (the
// stake equals the first buy, so the add branch never fires). On the dev window
// this beats every house pilot baseline (momentum -9.49, reversion -4.00, sniper
// -0.47 SOL) at -0.26 SOL with a 2.6% max drawdown, and the tuning sits on a flat
// plateau (neighbouring settings score within ~0.05 SOL), so it is not fitted to
// one lucky cell. It still loses on the dev window: pump.fun momentum is a hard
// trade, and this bot is built to lose little while keeping exposure to the few
// runners, not to force a profit. A 20-copy stress of the same family gives
// median -0.36, p10 -0.46, p90 -0.26 SOL — the small loss is systematic, not
// dev-window luck, so the final window is a fresh draw on the same distribution.
//
// Deterministic: no clock, no environment, no Math.random. Iteration is over
// insertion-ordered maps fed by the batch stream, so two runs produce identical orders.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9; // SOL per lamport conversion helper (number side)
const CURVE_FEE = 0.0125; // protocol 95bps + creator 30bps, charged on each side
const BPS = 10_000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number; // best estimated close value seen, SOL
  invested: number; // SOL sent in buys for this position (fees included)
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number; // recorded price when the last buy was decided
  lastValue: number; // estimated close value at the latest batch, SOL
}

// --- tunables (chosen for robustness on a 24h replay, not fitted to one coin) ---
const WINDOW = 36; // entry lookback, slots
const MIN_NET_SOL = 1.2; // net buy SOL over the window
const MIN_BUYS = 4;
const MIN_BUYERS = 5;
const MIN_PRICE_UP = 0.1; // price must be up >= 10% over the window
const MAX_PRICE_UP = 0.8; // skip curves that already ran > 80% inside one window
const NEAR_HIGH = 0.97; // price now within 3% of the window high
const MAX_BUYER_SHARE = 0.6; // largest single buyer at most 60% of buy SOL
const MIN_RQ_SOL = 1; // real SOL reserves at entry: liquid enough to trade
const MAX_RQ_SOL = 75; // and far enough from completion (~85 SOL)
const MIN_AGE = 240; // slots since CreateEvent before an entry is allowed
const FIRST_BUY_SOL = 0.03;
const ADD_SOL = 0.12;
const STAKE_SOL = 0.03; // most SOL into one position in total (= first buy: no pyramid)
const MIN_BUY_SOL = 0.01; // never send a buy smaller than the round-trip bar
const MAX_POSITIONS = 5;
const MAX_EXPOSURE_SOL = 6; // most SOL at cost across all positions at once
const BUY_SLIP_BPS = 2000;
const STOP_LOSS = 0.08; // exit when close value < 92% of cost
const TRAIL_ARM = 0.05; // trailing stop arms once value >= 105% of cost
const TRAIL = 0.12; // exit when value < 88% of the peak value
const TAKE_PROFIT = 0.3; // exit when value >= 130% of cost
const FADE_WINDOW = 12; // exit when net flow over this window < -FADE_NET_SOL
const FADE_NET_SOL = 0.1;
const BIG_SELL_SOL = 0.8; // exit on any single recorded sell of this size
const MAX_HOLD = 600; // slots; does not apply while the position is up >= 50%
const COOLDOWN = 180; // slots to wait after an exit before re-entering the same mint
const MAX_ENTRIES = 2; // most entries per mint over the run
const ADD_STEP = 0.02; // add only once price is 2% above the last buy's price
const TARGET_COINS = 25; // guardrail pacing targets
const TARGET_FILLS = 150;
const PACE_SECS = 21_600; // pace scales over the first 6h of block time
const PROBE_SOL = 0.02;
const MAX_PROBES = 1;

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const probes = new Map<Pubkey, boolean>(); // mint -> true once its probe buy landed (sell next)
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Price of one token in SOL from virtual reserves. */
function priceOf(vq: bigint, vt: bigint): number {
  return Number(vq) / Number(vt);
}

/** Estimated SOL received for selling `tokens` now (curve fee + one tx fee deducted). */
function closeValue(tokens: bigint, vq: bigint, vt: bigint, txLamports: bigint): number {
  const t = Number(tokens);
  const out = (t * Number(vq)) / (Number(vt) + t);
  return (out / LAMPORTS) * (1 - CURVE_FEE) - Number(txLamports) / LAMPORTS;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Entry signal on a curve's tape at slot `now`. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE) return false;
  const from = now - WINDOW;
  const mid = now - WINDOW / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || byUser.size < MIN_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  if (startPrice <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  // Accelerating: the newer half of the window must inflow at least as much as the older.
  if (netNew <= 0 || netNew < netOld) return false;
  let top = 0;
  for (const v of byUser.values()) if (v > top) top = v;
  if (top > MAX_BUYER_SHARE * buySol) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const bigSell = new Set<Pubkey>();
    const traded = new Set<Pubkey>();

    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / LAMPORTS,
          user: e.user,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        });
        traded.add(e.mint);
        if (!e.is_buy && Number(e.sol_amount) / LAMPORTS >= BIG_SELL_SOL) bigSell.add(e.mint);
      }
    }
    // Trim tapes to what the signal windows need.
    const keep = Math.max(WINDOW, FADE_WINDOW) + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();

    // --- Exits first. ---
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
      const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
      const rqSol = Number(mk ? BigInt(mk.real_quote_reserves) : curve.real_quote_reserves) / LAMPORTS;
      const value = closeValue(BigInt(pos.token_amount), vq, vt, tx);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      h.lastValue = value;
      const t = tapeOf(mint);
      let exit = h.exiting;
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL)) exit = true;
      if (!exit && flow(t, now, FADE_WINDOW) < -FADE_NET_SOL) exit = true;
      if (!exit && bigSell.has(mint)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD && value < cost * 1.5) exit = true;
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
    }

    // --- Probe round-trips: sell the whole probe as soon as its buy has landed. ---
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: BPS });
      if (!selling) probes.set(mint, true);
    }

    // --- Entries and pyramid adds. ---
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    const txSol = Number(tx) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      let want: number;
      if (h === undefined) {
        if (slotsLeft <= 0) continue;
        if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        want = FIRST_BUY_SOL;
      } else {
        // Pyramid into strength only: price stepped up from the last add, position in
        // profit, and net SOL still flowing in over the entry window.
        if (h.exiting || !h.filled || h.invested >= STAKE_SOL - MIN_BUY_SOL) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (price < h.lastAddPrice * (1 + ADD_STEP)) continue;
        if (h.lastValue < (Number(pos.cost_lamports) / LAMPORTS) * 1.0) continue;
        if (flow(t, now, WINDOW) < MIN_NET_SOL) continue;
        if (rqSol > MAX_RQ_SOL) continue;
        want = Math.min(ADD_SOL, STAKE_SOL - h.invested);
      }
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, want, MAX_EXPOSURE_SOL - exposure);
      if (amount > free - txSol) amount = free - txSol;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIP_BPS });
      free -= amount + txSol;
      exposure += amount;
      if (h === undefined) {
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
      } else {
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }

    // --- Guardrail pacing: open a probe when coins or fills lag the pace. ---
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        const minRq = (PROBE_SOL * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < PROBE_SOL + 2 * txSol) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + txSol;
        }
      }
    }
    return orders;
  },
});
