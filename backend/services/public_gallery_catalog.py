"""Server-owned registry for curated gallery items."""
from __future__ import annotations

from services.ppt_template_catalog import get_ppt_template


_CURATED_ITEM_IDS = frozenset(
    """
    poster-george-bass-guide
    poster-george-bass-route
    poster-patisserie-steps
    poster-cake-product
    poster-airclean-architecture
    poster-smartclean-robot
    poster-atelier-men
    poster-atelier-women
    poster-night-run
    poster-citrus-paper-collage
    poster-swiss-exhibition
    poster-new-chinese-tea
    science-nanocarrier-delivery
    science-flexible-battery
    science-watershed-ecosystem
    science-hydrogel-repair-concept
    image-zine-mountain-lake
    image-zine-rainy-harbor
    image-zine-train-journey
    image-moments-solar-term
    image-moments-photo-diary
    image-fantasy-cloud-market
    image-comic-ip-harbor
    image-character-bible-cloud-lantern
    image-library-stairwell-documentary
    image-eastern-still-life-plum
    image-coastal-paper-map
    image-natural-history-butterfly
    science-polymer-cycle
    science-soil-carbon-cycle
    science-organ-chip
    science-cool-roofs
    science-photonic-sensor
    meigen-tang-fantasy-space
    meigen-chili-topdown
    meigen-dragon-material
    meigen-candy-game-world
    meigen-brush-portrait
    high-concept-cosmic-vortex
    high-concept-orbital-forge
    high-concept-desert-rider
    high-concept-tiger-interceptor
    """.split()
)

_CANGHE_ITEM_NUMBERS = frozenset(
    int(value)
    for value in """
    501 499 490 488 483 472 450 436 414 408 393 383 377 366 357 273 272
    461 458 452 446 435 433 430 423 346 411 381 390 392 517 506 470 464
    462 460 455 454 449 441 438 432 431 424 418 417 406 401 396 373 367
    359 355 352 351 350 348 345 343 339 320 314 312 307 304 298 278 254
    469 457 456 447 443 407 380 375 364 361 360 353 341 334 333 296 248
    222 218 210 183 179 171 102 89 87 86 85 84 77 76 75 74 73 72 71 70
    69 68 67 66
    """.split()
)


def is_registered_static_item(item_key: str) -> bool:
    if item_key in _CURATED_ITEM_IDS:
        return True
    if item_key.startswith("meigen-hosted-"):
        suffix = item_key.removeprefix("meigen-hosted-")
        return suffix.isdecimal() and 1 <= int(suffix) <= 300
    if item_key.startswith("gallery-canghe-"):
        suffix = item_key.removeprefix("gallery-canghe-")
        return suffix.isdecimal() and int(suffix) in _CANGHE_ITEM_NUMBERS
    if item_key.startswith("ppt-template:"):
        template_id = item_key.removeprefix("ppt-template:")
        return bool(template_id and get_ppt_template(template_id))
    return False
