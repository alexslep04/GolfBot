# GolfBot

A playable variant of the card game Golf, with a basic computer opponent.

## Play

On Windows, double-click `play.bat`. Python must be installed; the launcher creates a local virtual environment and installs Pygame on first use.

Alternatively:

The window can be resized or maximized. The table scales to fit while preserving its proportions.

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
- **Discard:** discard your held draw and end the normal part of your turn. You can do this immediately after drawing as your first action, keeping all six layout cards and their visibility unchanged, or after flipping one of your own cards, keeping that revealed card in place.

After flipping your own card without drawing, **End turn** appears beside the turn prompt; Enter does the same thing. This implements path 1.1 without adding another main action button. Swapping, discarding, or End turn finishes the normal part of your turn, followed by any earned bonus swaps.

For an enabled Queen-Queen or Jack-Jack bonus, select **two** table cards and press the same **Swap** button. Either layout and both pile tops are eligible. The bot also follows the enabled rules. Hover over the **?** beside any rule for its explanation, loaded directly from RULES.md.

**Beggars Will be Choosers** pauses an opponent reveal for your rank guess when you qualify. Choose a rank or Pass. A correct guess highlights your highest and their lowest eligible visible cards: select one of each and press Swap. **4 of a Kind** offers a popup with the three column-pair choices and Keep layout; choosing an arrangement preserves hidden-card visibility and resumes the interrupted turn.

## Rules

[RULES.md](RULES.md) is the single source of truth for the rules, including turn paths, selectable rules, and interaction conventions. All optional rules start disabled, and the panel shows their state throughout the round.

Selectable rules include Queen-Queen and Jack-Jack bonus swaps, 666 locks, 777 division, King-Queen scoring, Hold 'em, V10, Tricky straights, The ripped 5, Roman 5s, Beggars Will be Choosers, and 4 of a Kind. Both V orientations count. See RULES.md for stacking, rounding, and information conventions. Earlier rule documents remain recoverable in Git history.

## Development

`game.py` contains the rules engine without UI dependencies, `scoring.py` contains optional scoring helpers, and `ui.py` contains the Pygame table. `rule_help.py` reads descriptions from RULES.md. Run checks with:

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

Visible subtotals exclude hidden cards and are not evaluation bars. Longer-term possibilities include estimated score advantage and win probability, a reinforcement-learning opponent, and a browser-playable version.
