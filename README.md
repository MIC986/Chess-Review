<div align="center">

<img src="docs/logo.png" width="112" alt="Chess Review logo" />

# Chess Review

**Fast, beautiful, offline game review for your chess.com games.**<br/>
Move classifications, accuracy, an eval graph and a coach who talks you through every move.

Chess.com reviews · open source.

[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-2b2926?style=for-the-badge&logo=windows&logoColor=white)](#-download)
[![Rust](https://img.shields.io/badge/Rust-Tauri%202-81b64c?style=for-the-badge&logo=rust&logoColor=white)](https://tauri.app)
[![Engine](https://img.shields.io/badge/engine-Stockfish%2019-749bbf?style=for-the-badge)](https://stockfishchess.org)

[**Download**](../../releases/latest)

[Features](#-features) · [Browser extension](#-browser-extension) · [Build from source](#%EF%B8%8F-build-from-source)

<br/>

<img src="docs/screenshots/review.png" alt="Reviewing a game in Chess Review" width="100%" />

</div>

<br/>

## Features

<table>
<tr>
<td width="50%" valign="top">

### Every move, classified
Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Miss and Blunder. Each move gets a badge on the board, tinted squares and a green arrow for the better move.

### A coach that actually talks
Pick **Maya**, **Leo** or **Bella**. Each coach has a natural neural voice that runs fully offline and explains *why* a move was good or bad: hanging pieces, forks, missed mates, material won.

### Accuracy & game rating
Per-player accuracy, an estimated game rating and phase grades for the opening, middlegame and endgame. If chess.com already reviewed the game, its accuracy is shown alongside for comparison.

</td>
<td width="50%" valign="top">

### Retry your mistakes
Jump into any inaccuracy, mistake or blunder and find the better move yourself, with hints, the solution and confetti when you get it right.

### Key moments & live analysis
Skip straight to the turning points, see live Stockfish lines, or drag any piece to explore your own ideas. Every explored move gets classified too.

### One click from chess.com
The browser extension makes chess.com's own **Game Review** buttons open the game here instead. Switch back any time from the toolbar.

</td>
</tr>
</table>

<br/>

<div align="center">
<table>
<tr>
<td align="center"><img src="docs/screenshots/summary.png" width="420" alt="Game summary" /><br/><sub><b>Game summary</b>: accuracy, ratings, move counts</sub></td>
<td align="center"><img src="docs/screenshots/best-move.png" width="420" alt="Best move" /><br/><sub><b>Best move</b>: takes back the mistake and plays the engine's choice</sub></td>
</tr>
<tr>
<td align="center"><img src="docs/screenshots/retry.png" width="420" alt="Retry" /><br/><sub><b>Retry</b>: find the better move yourself</sub></td>
<td align="center"><img src="docs/screenshots/coaches.png" width="420" alt="Coaches" /><br/><sub><b>Three coaches</b>, each with their own voice</sub></td>
</tr>
<tr>
<td align="center" colspan="2"><img src="docs/screenshots/games.png" width="620" alt="Games" /><br/><sub><b>Your games</b>: type a chess.com username and pick any game</sub></td>
</tr>
</table>
</div>

<br/>

## Download

1. Grab **`Chess-Review-1.0-Windows.zip`** from the [latest release](../../releases/latest).
2. Unzip it somewhere permanent (for example `Documents\Chess Review`).
3. Run **`Chess Review.exe`**.

> [!NOTE]
> On first launch the app offers two one-time downloads: the **Stockfish 19** engine (~80 MB) and the **coach voices** (~380 MB). After that, everything runs offline on your computer. No account, no login, no tracking.

Type your chess.com username, click a game and press **Start Review**.

<br/>

## Browser extension

Works in Chrome, Edge, Brave and Opera.

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder from the zip.
3. That's it. chess.com's **Game Review** buttons now open the game in Chess Review:

| Where on chess.com | What happens |
|---|---|
| Finished game page | *Game Review* opens the review in the app |
| Game-over screen | *Game Review* opens the review in the app |
| Your archive & profile | The review / accuracy link opens the review in the app |

Click the extension's toolbar icon to switch between **Chess Review** and **chess.com** for those buttons, and to see whether the app is running.

> [!TIP]
> While the app is open, reviews open instantly. When it's closed, the browser asks once to start Chess Review. Tick **Always allow**.

<br/>

## Keyboard shortcuts

| Key | Action | | Key | Action |
|:---:|---|---|:---:|---|
| <kbd>←</kbd> <kbd>→</kbd> | Previous / next move | | <kbd>F</kbd> | Flip board |
| <kbd>↑</kbd> <kbd>↓</kbd> | Previous / next key moment | | <kbd>B</kbd> | Show best move |
| <kbd>Home</kbd> <kbd>End</kbd> | Start / end of game | | <kbd>R</kbd> | Retry this mistake |
| <kbd>Space</kbd> | Autoplay | | <kbd>Esc</kbd> | Back to the game |

Right-drag on the board draws arrows and marks squares. The mouse wheel steps through moves.

<br/>

## Make it yours

Everything is customizable from **Settings**:

- **Board:** 14 themes, 12 piece sets, coordinates, animation speed, arrows, badges, eval bar, clocks, figurine notation
- **Coach:** choose your coach, speaking speed and volume, and whether to also read the better move
- **Engine:** strength presets (Fast → Maximum), search depth, parallel engines, threads, hash, or your own UCI engine
- **Interface:** Classic, Midnight or Slate theme, accent color, interface size, sounds

<br/>
