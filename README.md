# GolfBot

A simple playable version of a variant of the card game Golf, with a basic computer opponent.

## Play

On Windows, double-click `play.bat`. Python must be installed; the launcher creates a local virtual environment and installs the dependency on first use.

Alternatively:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe game.py
```

Click a card or the draw pile to select or unselect it, then use the buttons at the bottom. Reveal two of your cards to start.

At the start of your turn, you can select the **draw pile** and press **Flip**. Its top card is revealed and held for your decision. Select any one of your own six cards (face up or face down), then **Swap drawn**, or choose **Discard drawn**. The replacement enters face up and the removed card goes face up onto the discard pile. Either action ends your turn; drawing alone does not.

You can also flip one hidden card in your layout or choose **Skip flip**, then **Swap discard**, **Swap deck**, or **Draw & discard**. After flipping, only the newly revealed card can be swapped. After skipping, any of your face-up cards can be swapped. **Swap deck** commits a blind swap before revealing the incoming card; **Draw & discard** sends the next card straight to discard. Each of these actions ends your turn.

## This iteration

- One human dealer and one simple bot, using 52 cards and no jokers.
- The bot reveals two random cards initially and one hidden card each turn. It prefers beneficial discard swaps and otherwise makes simple draw decisions using visible cards only.
- Every replacement and discarded card is face up. Players cannot inspect hidden cards, including their own.
- Cards of the same rank in a column score zero, regardless of suit. Otherwise: Ace = 1, 2 = -2, 3–10 = their rank, Jack/Queen = 10, King = 0.
- After a player finishes a turn with all six cards face up, their opponent receives exactly one final turn. Remaining cards are then revealed and scored. Equal scores are a draw.
- When the draw pile is empty, its replacement is the shuffled discard pile, preserving the current top discard.
- Special combinations and house rules are reserved for a later iteration, including the Jack/Queen pair Joker substitute.
- Visible subtotals omit hidden cards and are not predictions of final scores.

The supplied rule documents are [RULES.md](RULES.md) and the more recent [RULES_UPDATED.md](RULES_UPDATED.md). The draw-first path above records the author's subsequent playtesting clarification; the newer pasted document describes only blind draw-pile swaps and direct draw-and-discard. The ending and deck-refill conventions above complete the base prototype where that document is unspecified.

## Longer-term direction

Future possibilities include evaluation bars for expected score advantage and win probability, a reinforcement-learning opponent, and a browser-playable version. This iteration focuses on the local base game.

The game engine is in `game.py` and can be used without importing Pygame. Run engine checks with `python -m unittest discover -s tests`.
