# Spike Rider v2 — Pump.fun Bot Sprint

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/nazarakaylaa-jpg/entries-pumpfun-bot-sprint-v2/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/nazarakaylaa-jpg/entries-pumpfun-bot-sprint-v2/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
competition on [make.fun](https://make.fun). It trades paper SOL on a replay of
pump.fun bonding-curve events (`agent-fun/replay/v2`) and is ranked on net PnL.

## Strategy

Only buy a launch that is already sprinting, size the bet to how hot the launch
looks, and cut losers fast. Two tiers:

- **Quality tier (0.2 SOL):** price >= 1.4x the create price within the first 3
  slots, with 10+ trades and 3+ distinct buyers already on the tape.
- **Filler tier (0.015 SOL):** every other launch that clears the same 1.4x
  run-up and the rug screen. Its trades are about breakeven on their own, but
  they are what the competition's 20-coin minimum bar needs on a 6-hour final
  window, and at 0.015 SOL a bad one costs almost nothing.

Both tiers share the same rug screen (skip when the creator sold before entry,
when the creator's own create-slot buy is outsized, or when sellers already
outweigh buyers) and the same exits: take-profit +20%, hard stop -3%, max hold
600 slots, creator sells while held, or the tape goes stale.

The bot tops a position up toward its stake in later batches while the coin
keeps climbing (the 1%-of-real-reserve buy cap means a 0.2 SOL stake cannot land
in one reply on a young curve). It is a pure function of the batches it is fed:
no clock, no randomness, no I/O, so the two grading runs agree byte for byte.

## Results on the dev window

Measured with the kit's local grader (`grade-local`, full 24h dev dataset):

- **Net PnL: +0.033 SOL** over 158 coins (positive in both halves of the window)
- Max drawdown: 0.8%
- The house sniper baseline loses -0.47 SOL on the same window.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`.
- `strategy.ts` — the strategy (parameters, entry/exit rules, rug screen).
- `vendor/makefun-bot.ts` — the kit's protocol shim, byte-identical to
  `sdk/ts/makefun-bot.ts` in the competition kit.

## License

MIT — see [LICENSE](LICENSE).
