# GolfBot

A playable variant of the card game Golf, with a basic computer opponent.

## Play

On Windows, double-click `play.bat`. Python must be installed; the launcher creates a local virtual environment and installs Pygame on first use.

Alternatively:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe game.py
```

Choose optional rules in the **Rules in play** sidebar before your second opening reveal. Reveal two of your own cards using **Flip** to start. The dealer (you) plays first. New game preserves your rule choices and lets you change them before the next round starts.

The four main actions are **Flip**, **Swap**, **Draw**, and **Discard**. Click a card to select or unselect it. Buttons are enabled only when their action is legal.

- **Flip:** reveal a selected hidden card of your own. You can do this before or after drawing. Selecting the draw pile and pressing Flip also reveals a draw, equivalent to Draw.
- **Swap:** select one own card. It takes your drawn card if you have one, otherwise the top discard. After flipping your own card, only that newly flipped card may be replaced. Otherwise any own card may be replaced, including a hidden card.
- **Draw:** reveal the top deck card and hold it for your decision, before or after flipping your own card. You cannot draw twice in one turn.
- **Discard:** discard the held draw after you have flipped one of your own cards, keeping that layout card in place. This follows path 2.2 in the supplied turn flow; drawing first requires either an immediate swap or a layout reveal before rejecting the draw.

After flipping your own card without drawing, **End turn** appears beside the turn prompt; Enter does the same thing. This implements path 1.1 without adding another main action button. Swapping, discarding, or End turn finishes the normal part of your turn, followed by any earned bonus swaps.

For an enabled Queen-Queen or Jack-Jack bonus, select **two** table cards and press the same **Swap** button. Either layout and both pile tops are eligible. The bot also follows the enabled rules.

## Rules

[PLAYING_RULES.md](PLAYING_RULES.md) is the current implemented specification, including the turn paths and the conventions used for special-rule interactions. All optional rules start disabled, and the panel shows their state throughout the round.

The supplied documents [RULES.md](RULES.md) and [RULES_UPDATED.md](RULES_UPDATED.md) are preserved as references. The latest requested numbered turn paths take precedence over the intermediate blind-swap version.

The current selectable rules are Queen-Queen bonus swaps, Jack-Jack bonus swaps, 666 locks, 777 final-score division, and King-Queen color scoring. The more extensive draft house-rule ideas in RULES_UPDATED.md are not selectable yet.

## Development

`game.py` contains the rules engine without UI dependencies; `ui.py` contains the Pygame table. Run checks with:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Visible subtotals exclude hidden cards and are not evaluation bars. Longer-term possibilities include estimated score advantage and win probability, a reinforcement-learning opponent, and a browser-playable version.
