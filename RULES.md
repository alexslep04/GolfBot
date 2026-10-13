# Golf rules

The single source of truth for this 52-card game. Optional rules are selected before the second opening flip and stay fixed for the round. Hover help reads the short marked descriptions below.

## Base version

**Terms:** each player has a **6-card hand**. Drawing from the **go-fish pile** is called **going fish**. Discards go face up onto the top of the **discard pile**.

**Start:** shuffle 52 cards. Deal each player six face-down cards in two rows of three. The rest form the go-fish pile; flip its top card to start the discard pile. Each player reveals any two of their own cards. The dealer plays first; turns alternate.

### 1. Flip one of your hidden cards

- **1.1:** Swap the revealed card with the top discard; end the turn.
- **1.2:** Keep the revealed card and end the turn.
- **1.3:** Go fish, then either replace the revealed card with the draw or discard the draw and keep the revealed card. End the turn.

### 2. Go fish first

- **2.1:** Swap the draw with a card already face up in your hand; discard the replaced card and end the turn.
- **2.2:** Reveal one hidden card, then either replace that card with the draw or discard the draw and keep the revealed card. End the turn.
- **2.3:** Discard the draw immediately and end the turn, leaving your hand unchanged.

Path 2.1 follows the author's clarification: the swap uses the go-fish card, not the discard pile. Path 2.3 retains the previously approved immediate-discard option.

### 3. Swap with the discard pile first

Replace any one of your cards with the top discard, discard the replaced card, and end the turn.

Normal replacements enter face up. After flipping a card during a turn, only that newly revealed card may be replaced. A swap, discard, or End turn completes the normal action; resolve earned bonus swaps afterward. Drawing alone does not end a turn.

## Ending and scoring

When either player has all six cards face up, finish the current turn and its bonuses, then give the other player one final turn. An already-triggered ending cannot be canceled. If a bonus reveals the non-acting player's sixth card, the acting player receives a fresh final turn. Finally reveal all hidden cards and score; these scoring reveals do not activate abilities. Lowest score wins; equal scores tie.

| Card | Points |
| --- | ---: |
| Ace | 1 |
| 2 | -2 |
| 3–10 | Rank |
| Jack, Queen | 10 |
| King | 0 |

Two cards of the same rank in a column score zero, regardless of suit. Breaking the pair restores their normal points. Empty go-fish piles are refilled by shuffling the discards except the current top card. Round every division upward, including negative scores.

## Selectable rules

### Queen-Queen and Jack-Jack bonus swaps
<!-- rule: queen_swap, jack_swap -->

A visible Queen-Queen or Jack-Jack column earns a swap of any two table cards at turn end, including either hand and both pile tops. Overrides locks. Each physical pair triggers once per round; different pairs can earn separate swaps.

### Devil's Row (666)
<!-- rule: devils_row -->

Three visible 6s in a row lock those cards for the round. Only a bonus swap may move them; the locks remain.

### Gambler's Row (777)
<!-- rule: gamblers_row -->

Three visible 7s in a row earn final score /7, rounded up. Earn once per player; the benefit remains if the row breaks.

### King-Queen Column
<!-- rule: king_queen -->

A King-Queen column scores 5 if the suits share a color, or 15 if their colors differ.

### Hold 'em
<!-- rule: holdem -->

A five-card flush, straight, full house, or four of a kind subtracts 5 points. Apply once, even with multiple qualifying combinations. Aces may be low or high; straights do not wrap.

### V10
<!-- rule: v10 -->

A Queen, Jack, and 10 in any order forming either V divide the final score by 5, rounded up. Apply once.

### Tricky straights
<!-- rule: tricky_straights -->

A row of ascending consecutive ranks adds the rightmost card's points. Descending ranks subtract its points. Each row counts separately; Aces may be low or high.

### The ripped 5
<!-- rule: ripped_five -->

A 5 of diamonds and one other 5 in the opposite row cancel to zero, even in different columns. Use each card only once; ordinary column pairs cancel first.

### Roman 5s
<!-- rule: roman_fives -->

A V whose cards total 10 points divides the final score by 3, rounded up. Either V orientation counts. Apply once.

### Beggars Will be Choosers
<!-- rule: beggars -->

The player with the highest visible card value may guess an opponent's chosen hidden card before it flips. A correct rank guess trades their highest visible card for the opponent's lowest visible card. Tied highest values give no guess; tied trade choices belong to the guesser. Locks apply.

### 4 of a Kind
<!-- rule: four_kind -->

Four visible cards of one rank may immediately be moved into any two columns, or left in place. Offer once per rank per player. Preserve hidden cards and locks; resume the turn afterward.

## Shared conventions

- Both Vs count: **top-left + bottom-middle + top-right**, or **bottom-left + top-middle + bottom-right**.
- Patterns use ranks and suits even when column scoring cancels their points. Tricky straights use ranks for order and Golf points for the adjustment; Aces may be 1 or 14 for order, but still score 1.
- Score columns first, including ripped-5 cancellation and King-Queen values. Then apply Tricky straights and the single Hold 'em reduction. Finally apply earned 777, Roman 5s, and V10 divisions. Modifiers may produce negative scores.
- Visible totals exclude hidden cards and final divisions. The effects panel also shows a provisional total after divisions proven by visible cards; it is not an evaluation of hidden cards or win chance.
- A ripped-5 cross-row pair uses the first unmatched opposite-row 5 from left to right. No card can be canceled twice.
- Beggars compares Golf point values, guesses ranks only, and includes the newly revealed card when finding the lowest visible card. Misses or passes simply continue the reveal. The acting player continues their original turn after a trade.
- Four-of-a-kind rearrangements keep the newly revealed physical card as the turn's replacement target. Initial opening flips and final scoring reveals do not activate interactive abilities.
- A bonus swap carries visibility into a hand; the go-fish pile stays face down and the discard pile face up. Unused pairs created by a bonus may earn another bonus. Empty piles have no card to select.
- Roman 5s keeps the approved **V total of 10** interpretation from the merged game, rather than three cards each worth 10.

## Revised draft rules — not selectable yet

### Joker Swap (54-card version)

A joker grants one swap of any two table cards, overriding locks. Resolve the swap, then continue a normal turn. A dealt joker is removed from the game and replaced from either pile before resolving its swap. This prototype uses 52 cards and the Queen/Jack substitutes instead.

### UNO

When a hand totals 1, opponents can call Uno to skip its owner's next turn. Calling Uno first protects the owner.

### Go Fish side hand

Deal each player four additional cards they may inspect. Before a turn, ask for a specific opponent side-hand card. If present, exchange it for a side-hand card of your choice; the trade consumes the turn. Otherwise play normally. A normal swap may exchange a main-hand card with a side-hand card.

### Black Out

Each card may be inspected once and marked as seen; showing it to opponents is optional. Claiming an ability reveals its cards for the round. Incorrect claims have no specified penalty. Reveal everything for final scoring.

### Socialism

After dealing the next round, the previous worst-scoring player may swap one of their two revealed cards with one of the previous best-scoring opponent's two revealed cards.

### Field Goal

A player finishing within 3 points of an opponent may try a paper-football field goal from 3 ft. Success changes their score to the opponent's, creating a tie.

### Suited Rows

Three cards of one suit in a row each take the middle card's face value.

### Gambler's Row dice variants

After 777, one die subtracts twice its result; two dice subtract their sum. Dice are not used in the prototype.

### Unfinished ideas

Colorblind starts with a hand containing all four suits, but its effect is unspecified. Other ideas include a single immovable card, turning cards face down again, and inspecting an opponent's hidden card.
