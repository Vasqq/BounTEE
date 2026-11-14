# BounTEE logo

The mark is an isometric block with two pause bars on its lid, drawn in the landing page's graph material. The wordmark is "BounTEE" in Switzer 600, with one seam cut through T, E and E at the x-height: their tops sit above it as lids, and their bodies line up with "Boun".

## Files

| File | Use |
| --- | --- |
| `bountee-lockup-on-dark.svg` / `-on-light.svg` | Mark and wordmark together: headers, slides, submissions |
| `bountee-wordmark-on-dark.svg` / `-on-light.svg` | Wordmark alone, where the mark already appears nearby |
| `bountee-mark.svg` | Mark alone; one colour set works on light and dark |
| `favicon.svg` | Browser tab; switches to the light block in dark mode |
| `favicon.ico` | Fallback tab icon, 16, 32 and 48 px |
| `apple-touch-icon.png` | iOS home screen, 180 px, on the page ground |
| `icon-512.png`, `icon-192.png` | Web manifest pair, block inside the maskable safe zone |
| `site.webmanifest` | Names the app and its icons for "add to home screen" |
| `og-image.png` | Link preview on X, Discord, Telegram, Slack: the landing hero as a 1200 × 630 card |
| `avatar-1024.png` | Profile picture for X and GitHub; the block clears the circle crop |
| `bountee-lockup-on-dark.png` / `-on-light.png` | Transparent PNGs, 1600 px wide, for tools that refuse SVG |

All SVGs are outlined paths: no fonts, no masks, transparent backgrounds.

## Wiring it into a site

Serve the files from the site root, and put this in `<head>` (the preview image needs the live domain):

```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#121213">
<meta property="og:image" content="https://DOMAIN/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
```

## Colours

- Wordmark on dark: ink `#eceeef`. On light: `#121213`.
- Mark faces: `#5b5c5e` top, `#444547` left, `#343536` right. Pause bars: `#00ec97`.

## Sizes

- Keep the lockup at least 20 px tall. Below that, use the mark alone: the seam is one pixel wide at that size and disappears below it.
- Leave clear space around the lockup equal to the height of the B.
- Don't recolour, stretch, outline or add effects. Green belongs only to the pause bars.
