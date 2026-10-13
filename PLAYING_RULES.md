# Rules implemented in GolfBot

## Deck and opening

Use a shuffled 52-card deck without physical jokers. Each player receives six face-down cards in two rows of three. The remainder is the face-down draw pile; its top card starts the face-up discard pile. Each player reveals any two of their own cards. The dealer plays first and turns alternate.

## Turn paths

There are three ways to begin a turn. All discarded cards go face up onto the top of the discard pile; all normal replacements enter the layout face up. Players cannot inspect hidden cards beforehand.

### 1. Flip one of your own hidden cards

- **1.1:** End your turn, leaving the card face up.
- **1.2:** Swap that newly revealed card with the top discard, then end your turn.
- **1.3:** Reveal the top draw-pile card, then:
  - **1.3.1:** Discard the drawn card and keep the revealed layout card, ending your turn.
  - **1.3.2:** Replace the newly revealed layout card with the drawn card and discard the replaced card, ending your turn.

### 2. Draw and reveal the top draw-pile card

- **2.1:** Replace any one of your own six cards with the draw, discarding the replaced card and ending your turn. The target can be face up or face down.
- **2.2:** Reveal one of your own hidden cards, then:
  - **2.2.1:** Discard that revealed layout card and replace it with your draw, ending your turn.
  - **2.2.2:** Discard your draw and keep the revealed layout card in place, ending your turn.

After path 2.2, only the card just revealed can be replaced. The two cards do not leave an empty position in the layout. Drawing alone does not end a turn. Rejecting a draw requires a layout reveal, as in path 2.2.

### 3. Take the top discard

Swap the top discard with any one of your own six cards, including a hidden card. Discard the replaced card and end your turn.

## Ending and scoring

Once either player has all six cards face up, their opponent receives exactly one final turn after the current player completes all decisions and bonus swaps. If a bonus reveals the non-acting player's sixth card, the acting player gets a new, complete final turn after finishing the current turn. A bonus that introduces another hidden card cannot cancel an already-triggered ending. At the end of the final turn, including its bonus swaps, reveal remaining hidden cards for scoring. These final scoring reveals do not activate new abilities. A tie is a draw.

Two cards of the same rank in a column score zero, regardless of suit. Otherwise sum their points: Ace = 1; 2 = -2; 3 through 10 = rank; Jack and Queen = 10; King = 0. Pair cancellation is temporary and stops when the pair is broken.

When the draw pile is empty, shuffle the discard pile except for its current top card to replenish it. Visible subtotals omit hidden cards and final-score division.

## Selectable rules

All optional rules start disabled. Select them during the opening reveal, before the second human opening card is flipped. Rule choices are shared by both players, fixed during a round, and carried into New game.

### Queen-Queen and Jack-Jack bonus swaps

These are independently selectable Joker substitutes for the 52-card deck. An enabled same-rank pair in a column grants a bonus swap at the end of its owner's normal turn, provided both cards are visible.

For this implementation, each physical pair grants its bonus **once per round**, across both players. Keeping, breaking, moving, or rebuilding that same pair cannot repeatedly earn it. Multiple eligible pairs grant separate bonus swaps; forming a different unused pair during a bonus can earn another. These conventions complete the unspecified repeated-trigger behavior in the supplied rules.

For each bonus, swap any two distinct existing table cards: either player's layout, the top discard, or the top draw-pile card. An empty pile has no top card to select. The bonus overrides 666 locks. No hidden card is inspected before selecting it.

Visibility follows the incoming card into a layout. Thus a face-down layout or draw-pile card stays face down when moved into a layout; a visible card stays visible. Draw-pile cards are always displayed face down and discard-pile cards face up. Previously observed identities can still be remembered.

### 666: Devil's Row

Three visible 6s in one row lock those three physical cards for the rest of the round. A normal swap cannot replace a locked card. A bonus swap can move it; its existing lock follows it and remains even after the row breaks. Hidden rows do not activate locks.

### 777: Gambler's Row

Three visible 7s in one row earn final-score division by 7, rounded upward. Earn it once per player per round; it persists after the row is broken. Apply it after column scoring. Dice variations are not used in this 52-card prototype.

### King-Queen column

A King and Queen in a column score 5 together when their suits share a color, or 15 when their suits have different colors. Hearts and diamonds are red; clubs and spades are black. Visible subtotals apply this only when both cards are visible; final scoring applies it to the fully revealed layout.
