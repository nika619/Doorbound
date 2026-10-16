# Run a pilot at home

Five real mornings tell you more than any simulation: how long your steps really take, whether your mornings run slow together, and whether Doorbound's chances were honest in your house. This is how to run one with nothing but a laptop in the kitchen. Everything stays in `data/household.json` on that laptop.

## Once (about ten minutes)

```bash
npm ci
```

```bash
npm run build
```

```bash
npm start
```

Open http://localhost:3939/sim and say (type, or hold the mic) each person's routine, in order, with the times you would normally guess:

> "Isha showers for 8 minutes, then gets dressed for 6, then breakfast for 4, then packs her bag for 3."

Say what can bend: "Isha's breakfast can be to go in 2 minutes", "Dad can pack Isha's bag", "the dishwasher can wait".

## Each evening

> "We leave at 7:40 tomorrow. When should everyone be up?"

Set the alarms it gives you.

## Each morning

1. When the first person starts: "Start the school run, we leave at 7:40."
2. Whenever someone finishes a step: pick them in the dock and say "I'm done" (or "Isha's done"). Say it when it happens; late taps blur the learning.
3. If something runs long: "Isha's still in the shower, five more minutes."
4. At the door: **"End the departure."** This is what scores the morning's chances, so do not skip it.

To see the board on a TV or tablet as well, start the server for the home network instead (pick your own secrets; at least 32 and 16 characters):

```bash
HOST=0.0.0.0 ALLOWED_HOSTS=192.168.1.20 AUTH_TOKEN=pick-a-long-secret-of-32-characters-or-more SCREEN_KEY=another-secret-16+ npm start
```

and open `http://192.168.1.20:3939/board#k=another-secret-16+` on the screen (use the laptop's address). The simulator stays on the laptop only.

## After five mornings

```bash
npm run pilot
```

It prints what each step really takes against what was said, how strongly your mornings run slow together (rho), and how honest the chances were: what Doorbound said, banded, against what happened. One household is a case study, not a trial; report it as that.
