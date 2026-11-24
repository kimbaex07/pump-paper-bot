# pump-paper-bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/kimbaex07/pump-paper-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/kimbaex07/pump-paper-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic momentum paper-trading bot for the pump.fun replay: it rides genuine buy flow on young bonding curves with one flat buy per position, and cuts losers fast with stop-loss, trailing stop, and fade exits.

## Strategy

Each batch folds the slot's trades into a per-mint tape (price from virtual reserves, SOL flow, distinct buyers). Entries need a mature curve with strong, accelerating buy flow; exits fire first on stop-loss (8%), take-profit (30%), a trailing stop armed at +5%, a fade in net flow, a single large sell, or a 600-slot hold limit. One flat 0.03 SOL buy per position, at most 5 open at once. Tiny probe round-trips only kick in if distinct coins or fills lag the guardrail pace. No clock, no randomness, no network — two runs produce byte-identical orders.

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot /home/hatch/workspace/make-fun/kim-bae/pump-paper-bot --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=cbprbg0z&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
