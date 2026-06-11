# Presence Path Finder

A small static website that looks up Discord's detectable application names and shows the Windows executable path Discord may associate with each game, so you can understand and test Discord rich presence detection behavior.

The site is built for Cloudflare Pages and uses an in-browser database loaded from a generated SQLite file (`public/detectable.db`). Search uses a full-text index for fast game-name lookup, with a prefix fallback for partial typing.

## What this simulates

Discord detects some games by process and executable path metadata. This project displays paths from Discord's public detectable applications endpoint so you can see what path shape Discord may expect.

For testing, a user may need to run an `.exe` with the same file name shown by the site. Some entries may also depend on the same folder or directory name being present in the path. Results are hints from the detectable database, not a guarantee that Discord will display a specific activity.

## Disclaimer

Use this project only for research, compatibility checks, personal testing, or educational purposes. Do not use it to impersonate activity, mislead people, evade platform controls, automate abuse, or violate Discord's terms, developer policies, game policies, or local law. You are responsible for how you use the information shown by this site.

This project is not affiliated with, endorsed by, or sponsored by Discord Inc.

## Stack

- Vite static app
- pnpm package manager
- `@fontsource/inter` and `@fontsource/jetbrains-mono` for self-hosted UI fonts
- `@sqlite.org/sqlite-wasm` for in-browser SQLite queries
- Python standard library generator (`generate_db.py`)
- GitHub Actions cron to refresh and commit the database
- Cloudflare Pages compatible output (`dist`)

## Local development

```bash
pnpm install
pnpm dev
```

Build the static site:

```bash
pnpm build
```

Lint the frontend:

```bash
pnpm lint
```

Preview the production build:

```bash
pnpm preview
```

## Regenerate the database

```bash
python generate_db.py --output public/detectable.db
```

`generate_db.py` fetches Discord's detectable applications list, extracts the best Windows non-launcher executable path for each game, and builds a SQLite database with:

- `games` table for display data
- `game_fts` FTS5 virtual table for game-name search
- indexes for normalized exact/prefix name lookups

## GitHub Actions refresh

The workflow in `.github/workflows/refresh-database.yml` runs daily at `20:17 UTC` (`03:17 Asia/Jakarta`) and can also be started manually from GitHub Actions.

It performs these steps:

1. Run `python generate_db.py --output public/detectable.db`.
2. Commit `public/detectable.db` only when the database changed.
3. Push the commit back to GitHub.
4. Let Cloudflare Pages redeploy from the source change.

For the workflow to push commits, repository Actions permissions must allow `Read and write permissions` for the default `GITHUB_TOKEN`.

## Cloudflare Pages

`public/_headers` sets COOP/COEP headers for SQLite WASM and a SQLite content type for `detectable.db`. Cloudflare Pages will publish this file automatically.

Recommended settings:

- Build command: `pnpm build`
- Build output directory: `dist`
- Node.js version: a current LTS release
- Package manager: pnpm (pinned via `packageManager` in `package.json`; no `PNPM_VERSION` env var needed unless overriding it)

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
