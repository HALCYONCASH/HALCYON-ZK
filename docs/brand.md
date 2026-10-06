# Brand

**Halcyon** (noun, adjective): a calm, peaceful spell; in the old story, the kingfisher that nests on a quiet sea. The name says what the launchpad wants to be among the others: calm, classy, simple. The tagline is *the calm Ethereum launchpad*. The site lives at halcyon.cash and speaks as @halcyoncash; both are configurable (`HALCYON_SITE_URL`, `HALCYON_X`), as is the name (`HALCYON_SITE_NAME`). The contracts carry no name at all.

## The mark

A prism, Ethereum's own shape, drawn as an outlined octahedron filled with the sky gradient (butter, rose, sky), floating over one line of water. Line weight 2 on a 40 unit grid, ink `#2d3761`, rounded joins. Files: `public/brand/halcyon-mark.svg`, `public/brand/halcyon-wordmark.svg`, `public/favicon.svg` (the mark on a sky tile). In the site the mark is the `Mark` component in `src/components/Shell.tsx`, so it can be drawn at any size.

The wordmark is the name in lowercase Space Mono, bold, tight tracking, with a small "eth" in DM Sans beside it. Lowercase mono after the Ethereum Foundation's own wordmark; the prism and the single wave are ours.

## Colour

Pastel skies with ink outlines, after the Foundation's illustrated landscapes. Everything is a token in `src/styles/halcyon.css`:

| token | value | used for |
|---|---|---|
| `--sky` | `#dcecf7` | the top of every page, the favicon tile |
| `--sky-2` | `#f3dcea` | the pink of the hero's sky |
| `--mint` | `#d3efe1` | Holders module, ready tags |
| `--lav` | `#dcd6f6` | Stock module, mountains |
| `--peach` | `#fde3cc` | Burn module, clouds at dusk |
| `--butter` | `#f9efc2` | Keep module, the demo tag |
| `--ink` | `#2d3761` | every line and every word |
| `--ink-2`, `--ink-3` | `#5a6391`, `#8d93b6` | secondary and faint text |
| `--rose`, `--teal`, `--gold`, `--grass`, `--violet` | accents | progress bars, the sparkline, buys and sells |
| `--paper` | `#fbfaf6` | the page below the sky |

The page background is one gradient from sky to paper over the first thousand pixels; cards are translucent white with a faint ink border and a soft shadow. Light theme only, by design: the pastels are the brand.

## Type

- **Fraunces** (variable, soft optical axis) for headings: a warm serif with a little wonk, set at `SOFT 80`, tight tracking.
- **DM Sans** (variable) for everything else.
- **Space Mono** for the wordmark, numbers, addresses and anything a trader reads at a glance.

All three load from `@fontsource` packages, so the site serves its own fonts and loads nothing from outside.

## Illustration

The hero scene (`src/components/Hero.tsx`) is an SVG in the Foundation's manner: outlined clouds (two stacked ellipse layers, the lower one stroked, the upper one filled, so the outline reads as one shape), the sun on the horizon and its path on the lake, two ranges of mountains in lavender and mint, reeds at the shore, birds, sparkles; the mark, the name and one line sit on top of it. The clouds drift, the mark bobs, the sun's path shimmers and the sparkles twinkle with CSS animations that stop under `prefers-reduced-motion`. The ten demo coins have line-art avatars in the same style under `public/demo/`.

Module icons are line icons on a 24 unit grid (`ModuleIcon` in `src/components/CoinCard.tsx`), the garden's: a stem with its roots (Roots), a rain cloud (Rain), shears over a cut stem (Prune), a sheaf of leaves (Harvest), a stem that branches (Branch), a four-leaf clover (Clover), the rings of a trunk (Rings), three drifts of mist (Mist). No emoji anywhere in the interface. Stock logos come from the issuers' own CDNs.

## Voice

Short sentences, no hype, numbers where they matter. The site explains what happens and who pays; it never promises what a coin will do. Say "coin", not "token", on the site; "token" in the contracts and the API where it is the address.

## The previews

`docs/brand/` holds the repository's pictures, 21:9 at 2520x1080: `banner.png` (the brand card with the way of a fee, the eight modules and the mainnet addresses) and three screens of the demo site (`coin.png`, `coins.png`, `stats.png`). `node scripts/previews.mjs` draws them again from the built site and the demo server, with the same fonts the site serves; `--only banner` draws one.
