"""Glicko-2 ratings (Glickman, 2012), on a scale that starts at 1000 rather than 1500.

A rating is three numbers: the rating itself, its deviation (RD: how unsure the
rating is; it shrinks as someone plays and grows while they are away), and its
volatility (how erratic their results have been). Every result is rated on its
own, as a rating period of one game, against the opponent's numbers going in.
"""
import math

START, START_RD, START_VOL = 1000.0, 350.0, 0.06
MAX_RD = 350.0
# Above this RD a rating is still settling (shown with a "?").
PROVISIONAL_RD = 110.0
SCALE = 173.7178  # Glicko-2 works on its own scale; this converts to and from it
TAU = 0.5  # how quickly volatility may change
# Time away widens the deviation, one step per day not played.
PERIOD = 86400.0
# A new patch widens it once, so ratings re-settle quickly on changed rules.
PATCH_RD = 150.0


def _g(phi):
    return 1 / math.sqrt(1 + 3 * phi * phi / math.pi ** 2)


def _expected(mu, mu_j, phi_j):
    # clamped: a huge gap must not round to a certain result (a division by zero below)
    return min(1 - 1e-9, max(1e-9, 1 / (1 + math.exp(max(-700, min(700, -_g(phi_j) * (mu - mu_j)))))))


def expected(player, opponent):
    """The score (0-1) `player` is expected to take from `opponent`; each is (rating, rd, ...)."""
    return _expected((player[0] - START) / SCALE, (opponent[0] - START) / SCALE, opponent[1] / SCALE)


def idle(rd, volatility, seconds):
    """The deviation after `seconds` without a rated result."""
    phi = rd / SCALE
    periods = max(0.0, seconds) / PERIOD
    return min(MAX_RD, math.sqrt(phi * phi + periods * volatility * volatility) * SCALE)


def widen(rd, by=PATCH_RD):
    """The deviation after a one-off loss of certainty (a new patch)."""
    return min(MAX_RD, math.hypot(rd, by))


def update(player, results):
    """`player` after `results`, as (rating, rd, volatility).

    player: (rating, rd, volatility). results: [((rating, rd), score), ...] with a
    score of 1 for a win, 0.5 for a draw and 0 for a loss against that opponent.
    """
    rating, rd, volatility = player
    mu, phi = (rating - START) / SCALE, rd / SCALE
    if not results:
        return rating, min(MAX_RD, math.sqrt(phi * phi + volatility * volatility) * SCALE), volatility
    inverse_v = improvement = 0.0
    for (other, other_rd, *_), score in results:
        mu_j, phi_j = (other - START) / SCALE, other_rd / SCALE
        g, e = _g(phi_j), _expected(mu, mu_j, phi_j)
        inverse_v += g * g * e * (1 - e)
        improvement += g * (score - e)
    v = 1 / inverse_v
    delta = v * improvement
    # the new volatility, by the Illinois algorithm of the paper (step 5)
    a = math.log(volatility * volatility)

    def f(x):
        ex = math.exp(x)
        return ex * (delta * delta - phi * phi - v - ex) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (TAU * TAU)

    low = a
    if delta * delta > phi * phi + v:
        high = math.log(delta * delta - phi * phi - v)
    else:
        k = 1
        while f(a - k * TAU) < 0:
            k += 1
        high = a - k * TAU
    f_low, f_high = f(low), f(high)
    while abs(high - low) > 1e-6:
        middle = low + (low - high) * f_low / (f_high - f_low)
        f_middle = f(middle)
        if f_middle * f_high <= 0:
            low, f_low = high, f_high
        else:
            f_low /= 2
        high, f_high = middle, f_middle
    new_volatility = math.exp(low / 2)
    phi_star = math.sqrt(phi * phi + new_volatility * new_volatility)
    new_phi = 1 / math.sqrt(1 / (phi_star * phi_star) + 1 / v)
    new_mu = mu + new_phi * new_phi * improvement
    return new_mu * SCALE + START, min(MAX_RD, new_phi * SCALE), new_volatility
