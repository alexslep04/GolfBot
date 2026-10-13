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
- **2.3:** Discard the drawn card immediately without revealing or replacing any layout card, ending your turn.

After path 2.2, only the card just revealed can be replaced. The two cards do not leave an empty position in the layout. Drawing alone does not end a turn. Discarding that draw ends the normal part of the turn immediately and leaves all layout cards as they are, followed by any earned bonus swaps.

### 3. Take the top discard

Swap the top discard with any one of your own six cards, including a hidden card. Discard the replaced card and end your turn.

## Ending and scoring

Once either player has all six cards face up, their opponent receives exactly one final turn after the current player completes all decisions and bonus swaps. If a bonus reveals the non-acting player's sixth card, the acting player gets a new, complete final turn after finishing the current turn. A bonus that introduces another hidden card cannot cancel an already-triggered ending. At the end of the final turn, including its bonus swaps, reveal remaining hidden cards for scoring. These final scoring reveals do not activate new abilities. A tie is a draw.

Two cards of the same rank in a column score zero, regardless of suit. Otherwise sum their points: Ace = 1; 2 = -2; 3 through 10 = rank; Jack and Queen = 10; King = 0. Pair cancellation is temporary and stops when the pair is broken.

When the draw pile is empty, shuffle the discard pile except for its current top card to replenish it. Visible subtotals omit hidden cards and final-score division.

## Selectable rules

All optional rules start disabled. Select them during the opening reveal, before the second human opening card is flipped. Rule choices are shared by both players, fixed during a round, and carried into New game.

### Queen-Queen and Jack-Jack bonus swaps
<!-- rule: queen_swap, jack_swap -->

These are independently selectable Joker substitutes for the 52-card deck. An enabled same-rank pair in a column grants a bonus swap at the end of its owner's normal turn, provided both cards are visible.

For this implementation, each physical pair grants its bonus **once per round**, across both players. Keeping, breaking, moving, or rebuilding that same pair cannot repeatedly earn it. Multiple eligible pairs grant separate bonus swaps; forming a different unused pair during a bonus can earn another. These conventions complete the unspecified repeated-trigger behavior in the supplied rules.

For each bonus, swap any two distinct existing table cards: either player's layout, the top discard, or the top draw-pile card. An empty pile has no top card to select. The bonus overrides 666 locks. No hidden card is inspected before selecting it.

Visibility follows the incoming card into a layout. Thus a face-down layout or draw-pile card stays face down when moved into a layout; a visible card stays visible. Draw-pile cards are always displayed face down and discard-pile cards face up. Previously observed identities can still be remembered.

### 666: Devil's Row
<!-- rule: devils_row -->

Three visible 6s in one row lock those three physical cards for the rest of the round. A normal swap cannot replace a locked card. A bonus swap can move it; its existing lock follows it and remains even after the row breaks. Hidden rows do not activate locks.

### 777: Gambler's Row
<!-- rule: gamblers_row -->

Three visible 7s in one row earn final-score division by 7, rounded upward. Earn it once per player per round; it persists after the row is broken. Apply it after column scoring. Dice variations are not used in this 52-card prototype.

### King-Queen column
<!-- rule: king_queen -->

A King and Queen in a column score 5 together when their suits share a color, or 15 when their suits have different colors. Hearts and diamonds are red; clubs and spades are black. Visible subtotals apply this only when both cards are visible; final scoring applies it to the fully revealed layout.

### Hold 'em
<!-- rule: holdem -->

Check every five-card subset of the six-card layout. A flush (five cards of the same suit) subtracts 2 points; a straight (five distinct consecutive ranks) subtracts 2; a full house (three of one rank and two of a different rank) subtracts 5; four of a kind subtracts 5; a royal flush (same-suit 10, Jack, Queen, King, Ace) subtracts 10. Aces can be low in A-2-3-4-5 or high in 10-J-Q-K-A; straights cannot wrap around. Each qualifying category applies once and categories stack, so a royal flush earns a total reduction of 14. Six matching-suit cards do not earn multiple flush reductions. Visible subtotals include a bonus only if enough visible cards prove it; the final score checks all six cards.

### V10
<!-- rule: v10 -->

A Queen, Jack, and 10 in any order occupying a V divide the final score by 5, rounding upward. Both V orientations count: top-left + bottom-middle + top-right, or bottom-left + top-middle + bottom-right. This modifier applies once even when both orientations qualify. Evaluate the final layout; revealing or breaking a V earlier does not permanently earn the effect.

### Tricky straights
<!-- rule: tricky_straights -->

Three consecutive ranks in ascending order from left to right in a row add the rightmost card's Golf point value to the score. Descending order subtracts that value. Evaluate each row separately. Aces can be low or high, but sequences cannot wrap around; Q-K-A and A-K-Q count, K-A-2 does not. Ranks determine the sequence (Jack = 11, Queen = 12, King = 13); ordinary Golf points determine the adjustment (2 = -2, King = 0, Ace = 1). Visible subtotals include a row only when all three cards are visible.

### The ripped 5
<!-- rule: ripped_five -->

A 5 of diamonds and at least one other 5 anywhere in the layout subtract 5 points. Apply this once per player, even with three or four 5s. The final layout determines the effect; both required cards must be visible to include it in a visible subtotal.

### Roman 5s
<!-- rule: roman_fives -->

Three cards whose Golf points sum to 10 occupying either V orientation divide the final score by 3, rounding upward. For example, 6 + Ace (1) + 3 qualifies. Use Golf points, including 2 = -2 and King = 0. Both top-left + bottom-middle + top-right and bottom-left + top-middle + bottom-right count. Apply the modifier once, even if both Vs qualify. Evaluate the final layout. This is separate from V10 and can stack with it.

### Beggars Will be Choosers
<!-- rule: beggars -->

Before a player flips a chosen hidden layout card during a normal turn, compare each player's highest visible Golf point value. If one player has a strictly higher value and is the opponent of the player flipping, they may guess the selected card's rank (Ace through King) or pass. Equal highest values grant neither player a guess. The chosen card stays hidden until the guess is submitted. A correct rank guess reveals the card, then the guesser selects one of their highest-value visible cards and one of the opponent's lowest-value visible cards to trade. The newly revealed card is included when finding the opponent's lowest value. Tied eligible cards are chosen by the guesser. Normal 666 locks apply; if no legal highest/lowest trade is possible, the reveal continues without a trade. Wrong guesses and passes simply continue the reveal. The trade does not consume the acting player's turn; they continue their original flip-first or draw-first path. Initial opening reveals and final scoring reveals do not prompt guesses. The bot guesses without accessing the hidden card.

### 4 of a Kind
<!-- rule: four_kind -->

When four cards of the same rank are visible anywhere in a player's layout, immediately offer that player the choice to put those four cards into any two selected columns or to keep the layout. The two remaining cards fill the unused column and retain their visibility. The choice applies once per rank per player per round. A reveal, normal replacement, or bonus swap can trigger the offer, but final scoring reveals cannot. Rearrangement does not itself end the acting player's turn. After rearranging a newly revealed card, that same physical card remains the only legal replacement target for the flip-first or draw-then-flip path. This ability cannot move any 666-locked card; column choices that would do so are unavailable. The Hold 'em four-of-a-kind score reduction is a separate selectable rule.

## Combined scoring

First score the columns, including same-rank cancellation and optional King-Queen scoring. Then add the Tricky straights adjustments and subtract qualifying Hold 'em and ripped-5 reductions. Finally apply earned 777 division, Roman 5s, and V10. Every division rounds upward; applying these positive integer divisors successively is equivalent to dividing by their product and rounding upward once. Modifiers can produce negative final scores. Column cancellation does not erase a card's rank or suit for other patterns. Visible subtotals include provable additive adjustments, but omit hidden-card effects and all final-score divisions.

## Hover help and draft ideas

Every selectable rule has a question-mark icon. Its hover explanation is read directly from the marked rule section of this document, so RULES.md remains the only authoritative rules document.

Two conventions used on the features branch remain open to feedback: stacking Hold 'em categories once each, and using visible Golf point values plus rank-only guesses for Beggars. Both V orientations were explicitly confirmed by the author.

Undeveloped ideas remain drafts: **Suited Rows** makes three cards of one suit in a row each worth the second-largest card's value; **Colorblind** begins with a hand containing all four suits but has no defined effect; a **single immovable card** has no specified trigger. Physical-joker and dice variations are outside this 52-card game. These unfinished drafts are not selectable.
