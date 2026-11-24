// Spike Rider v2 — a pump.fun launch momentum bot for agent-fun/replay/v2.
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts,
// the protocol in the vendored SDK shim (vendor/makefun-bot.ts, a byte-identical
// copy of the kit's sdk/ts/makefun-bot.ts).
//
// The bot buys only launches that are already sprinting (price >= 1.4x the create
// price within 3 slots), sizes the bet to how clean the launch looks (0.2 SOL for
// hot-and-clean launches, 0.015 SOL for the rest that clear the rug screen),
// tops the position up toward its stake while the launch keeps climbing, and
// exits at take-profit +20%, stop-loss -3%, or after 600 slots. See strategy.ts
// for the full reasoning.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
