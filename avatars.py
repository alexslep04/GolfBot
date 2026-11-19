"""Player avatars.

Avatars are cosmetic today. Each entry already carries the fields upcoming
gameplay will need, so an avatar can later switch rules on, adjust scoring, or
grant abilities without changing how seats, sessions, or snapshots store it.
"""
from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Avatar:
    id: str
    name: str
    icon: str  # SF Symbol name; the web client draws it as a sticker.
    selectable: bool = True
    # (kept in the public catalog; any avatar may now be worn by several players)
    shared: bool = False
    # Reserved for upcoming gameplay. Keep these empty until the engine reads them.
    rules: tuple = ()      # rule keys this avatar forces on for its player
    bonuses: tuple = ()    # scoring adjustments, e.g. {"kind": "flat", "points": -1}
    abilities: tuple = ()  # activated or passive ability keys


AVATARS = (
    Avatar("tree", "Tree", "tree.fill"),
    Avatar("bird", "Bird", "bird.fill"),
    Avatar("dog", "Dog", "dog.fill"),
    Avatar("cup", "Cup", "cup.and.heat.waves.fill"),
    Avatar("fork", "Fork", "fork.knife"),
    # in the middle of the picker, and everyone's starting choice
    Avatar("club", "Golfer", "figure.golf", shared=True),
    Avatar("cat", "Cat", "cat.fill"),
    Avatar("fish", "Fish", "fish.fill"),
    Avatar("hare", "Hare", "hare.fill"),
    Avatar("tortoise", "Tortoise", "tortoise.fill"),
    Avatar("ladybug", "Ladybug", "ladybug.fill"),
    Avatar("golfbot", "Golfbot", "gamecontroller.fill", selectable=False),
)
BY_ID = {avatar.id: avatar for avatar in AVATARS}
DEFAULT_AVATAR = "club"
BOT_AVATAR = "golfbot"


def catalog():
    """Public avatar list, including the reserved (currently empty) perk fields."""
    return [asdict(avatar) for avatar in AVATARS]


def clean_avatar(value):
    """Return a selectable avatar id, or raise ValueError for anything else."""
    avatar = BY_ID.get(value)
    if avatar is None or not avatar.selectable:
        raise ValueError("Choose one of the available avatars.")
    return avatar.id
