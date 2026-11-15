# Demo script: the habitat assistant (Ask tab)

Three questions that show the assistant's three jobs, then one live fallback. About 2 minutes live. For the 30-second Space Apps video, use question 2 only (it shows grounding, sources and the safety role in one answer).

**Before you start**
- Zone **Z2 Bright Angel** (`#z2`), the four package stops, **Find safest route** pressed, plan **not** approved.
- Internet on. The Worker has at least two keys (Gemini first, Groq second).
- Open the **Ask** tab.

## 1. Grounding: the answer comes from the mission data

**Ask:** "What's the temperature at 14:00?"

**Expect:** about −49 °C air and about −2 °C ground at 14:00, said to be the median of what Perseverance's MEDA station measured on sols 1210–1218 (July 2024), not a forecast.

**Point at:**
- The purple **AI explanation** tag, and the line with the provider and model that wrote it.
- The two values under the answer and the **S4** chip (Perseverance MEDA, NASA PDS). The values come from our tools, not from the model.
- **Read all · N values** opens every value it looked up, each with its source ID.

## 2. Safety explainer: Baramger's checks decide, the AI explains

**Ask:** "Where do we lose radio contact?"

**Expect:** two short stretches without line of sight to the habitat antenna, each with the leg, the clock time and how far into the leg it starts. The longest is about 4 minutes, under the 15-minute limit (A9), so the radio check says "take care", not "fail".

**Point at:**
- The **PLAN** source: the gaps are computed by Baramger's own radio line-of-sight check (`los.ts`) on the HiRISE terrain (**R1**), not by the AI.
- Open the **Safety** tab: the radio check shows the same result. The assistant explains the check; it never changes it and never calls a plan safe by itself.

## 3. Honesty: "I can't tell" instead of a guess

**Ask:** "What radiation dose will we get at Cheyava Falls?"

**Expect:** "I can't tell from the mission data.", then one sentence on what the data does have (sun activity measured near Earth, NOAA **S7** / NASA DONKI **S3**).

**Point at:** the package has no radiation dose for this place, so the assistant says so instead of using general knowledge about Mars.

(Optional, off topic: "What's the capital of France?" gets one polite sentence: it only helps with the walk, the zone and its data.)

## 4. Live fallback: the next provider answers

**Locally** (recommended, nothing to undo on the live site):
1. In `app/.dev.vars`, put `#` in front of the `GEMINI_API_KEY` line.
2. Restart `npx wrangler dev`.
3. Ask question 1 again.

**Expect:** the same answer, now written by **Groq · openai/gpt-oss-120b**, with the line **Tried first: Gemini (Google): no key set**. Put the key back afterwards.

**On the deployed Worker** (only if you must): `npx wrangler secret delete GEMINI_API_KEY`, ask, then `npx wrangler secret put GEMINI_API_KEY` to restore it. A real rate limit looks the same, with "busy (rate limit)" instead of "no key set".

## If something goes wrong

- **"The assistant needs an internet connection."** The browser is offline. Every other tab still works.
- **"The assistant isn't available right now. Try again in a minute."** Every provider failed or is resting. The Worker's logs (`npx wrangler tail`) say why for each provider. They never contain the question.
- **"You asked several questions in a short time."** The limit is 5 questions a minute per visitor.
