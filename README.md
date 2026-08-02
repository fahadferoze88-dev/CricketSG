# Cricket SG Central Stats

A static, read-only season statistics site for Cricket SG Central. The app loads one client-side file, `public/data.json`, and renders match day scorecards, current-season leaderboards, Hall of Fame lists, and searchable player histories.

## Local Development

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Production Build

```bash
npm install
npm run build
```

The build output is written to `dist/` and is suitable for Vercel static hosting.

## Refreshing Data

Replace `public/data.json` with the latest generated CricketOps export, then rebuild or push to GitHub so Vercel redeploys.

The app treats `data.views` as authoritative for Match Day, Season, and Hall of Fame pages. It only uses `data.raw` for player-history joins.

## Automated Data Sync

The GitHub Action in `.github/workflows/sync-data.yml` checks the stable MEGA folder every six hours and can also be run manually from GitHub Actions. It downloads `data.json`, accepts either the final web contract or the MEGA `tables` export, converts it into the web-ready shape, replaces `public/data.json`, and commits only when the file changed.

The converter lives in `scripts/download-mega-data.cjs`. If the MEGA folder link changes, update `MEGA_FOLDER_URL` in `.github/workflows/sync-data.yml`.

For this to work, the GitHub repository must allow Actions to write: `Settings` -> `Actions` -> `General` -> `Workflow permissions` -> `Read and write permissions`.

## Design Tokens

The color palette is defined once in `src/styles.css` under the `:root` CSS custom properties. Keep brand colors there so scorecards, Hall of Fame rows, and negative-score styling stay consistent.

## Privacy

Search indexing is blocked with both:

- `<meta name="robots" content="noindex,nofollow">` in `index.html`
- `public/robots.txt` with `Disallow: /`

The site is unlisted, not authenticated.
