# Naija Games (Whot + Ludo)
Naija Games is a free, browser-based home for Nigeria’s favourite games. Play Whot or Ludo with up to four players, each on their own device, using a room code. The server deals the cards and rolls the dice, so every move is fair. It has a 3D look, win-chance bars, a winner celebration, a customisable sound library, and one-die or two-dice Ludo.
One Node.js server that runs both games online. Players connect with WebSockets. The server holds the game state, rolls the Ludo dice, deals the Whot cards and checks every move, so nobody can cheat.

- `/` home page with the two games
- `/whot.html` Naija Whot, 2 to 4 players
- `/ludo.html` Naija Ludo, 2 to 4 players
- `/sounds/` the sound library

Ludo can be played with one die or two. The host picks "1 die" or "2 dice" in the lobby (and again on the end screen before a rematch). With two dice, each die is a separate move for any pawn. Doubles, a capture or a pawn home give another roll, and three doubles in a row lose the turn.

## Run on your computer
    npm install
    npm start
Open http://localhost:3000 in two tabs. In one, choose a game and tap Create room. In the other, open the same game, enter the code and tap Join.
For phones on the same Wi-Fi, open http://YOUR-COMPUTER-IP:3000.

## Put it online (example: Render)
1. Put these files in a GitHub repository.
2. On render.com choose New, then Web Service, and connect the repository.
3. Build command `npm install`, start command `npm start`.
4. Share the URL Render gives you. The pages use a secure connection automatically.

Free hosts sleep when nobody is using them, so the first load can take about a minute. Choose the server region closest to your players.

## Database, feedback and admin dashboard
For persistent feedback and daily statistics, create a free Postgres database with a hosted provider such as Supabase or Neon. Create a project/database, copy its Postgres connection string, and add these environment variables in the Render service's **Environment** settings:

- `DATABASE_URL`: the provider's Postgres connection string. The server uses SSL and creates the required tables and indexes on startup.
- `ADMIN_KEY`: a long, randomly generated secret with at least 16 characters. Keep it private; do not put it in source control or share it with players.

Open `https://YOUR-RENDER-SERVICE.onrender.com/admin` and authenticate with any username and the `ADMIN_KEY` as the password. The dashboard updates while its tab is visible and includes CSV downloads and administrative controls. If `ADMIN_KEY` is missing or shorter than 16 characters, `/admin` returns 404.

Without `DATABASE_URL`, the app logs one warning and stores feedback and player records as JSON Lines in `./data/`. Daily statistics are only kept in memory in this mode. Render's free filesystem is ephemeral, so fallback files are lost when the service restarts or is redeployed. Live counters are always in memory; sleeping or restarting resets them, while daily statistics already flushed to Postgres remain available.

### Privacy
Feedback stores the submitted username, six ratings, voice-chat answer, optional comment, game, device category, measured round-trip time, app version and anonymous client ID. The `players` table stores the anonymous client ID, username, first/last-seen times and games played. No IP addresses, hands or dice are stored in the database or exposed by the admin API. An administrator can honor a data-deletion request using the anonymous client ID in the dashboard's **Delete player and feedback** control; this removes that player's `players` row and feedback rows.

## Sound library
Each folder in `public/sounds/` is a pack. Drop a `.wav`, `.mp3` or `.ogg` file in (3 seconds or less, file names with letters, numbers, - and _ only) and it shows up in every player's sound picker. No code change or restart needed.
Add `pack.json` to a folder to name it: `{"title":"Pack name","explicit":true}`. Explicit packs are hidden for players who turn on clean mode.
`starter/` holds 10 original synthesized sounds. Only add sounds you made or have the right to use.

Players pick a sound for each moment (six, captured, home, win, and so on). Everyone hears the library sound chosen by the player who triggers the moment. Files a player uploads stay on their own device and are never sent to other players.

## Screen sizes
The Ludo board fills the width of a phone held upright and the full height on a laptop or a phone held sideways. Pawns have a tap and click area of at least 48 px on every screen.

## Notes
- Games live in the server's memory. Restarting the server ends all games.
- A player who loses connection has 45 seconds to come back (the page reconnects by itself). After that a computer takes their seat.
- Human turns have a 30-second timer by default. Set `TURN_MS` (milliseconds, default `30000`) to change it, and `MAX_MISSED` (default `1`) to choose how many missed turns are allowed before a player is replaced by a computer. Ludo starts a separate timer for rolling and for choosing a move.
- Room chat keeps the latest 50 messages in memory and restores them when a player rejoins.
- Room codes are 4 characters. Up to 4 players per room, computers included.
