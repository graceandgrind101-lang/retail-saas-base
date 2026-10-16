# Trying the app on your own computer

Everything here runs locally: your computer, Docker, and a demo shop. Nothing is sent anywhere.
Written for the owner; no coding needed, just typing a few commands in a terminal in the project folder.

## One-time setup

1. **Open Docker Desktop** and wait until it says it is running.
2. In the project folder:

```
pnpm install        (only if you have not run it lately)
pnpm db:up          starts the local database
pnpm dev:setup      makes apps/web/.env.local with fresh secrets and prepares the database
pnpm dev:seed       creates the demo shop and prints a connection code
```

`dev:setup` is safe: it never overwrites an existing `apps/web/.env.local`. `dev:seed` can be run again
any time for a fresh code (a code works once and for 10 minutes).

## Start the app

```
pnpm dev
```

Open http://localhost:3000/sign-in. Stop with Ctrl+C.

## What to try

**As the owner (the whole admin app)**
1. On the sign-in page press **Sign in as the demo owner**. You land on Home: tiles with the open alerts.
2. Open **Alerts** (menu, or the bell). There are two sample alerts. Tap one: **Mark as seen**, then **Resolve** with a note. Tap **Show closed alerts** to see it kept. A closed alert cannot be reopened.
3. Press **Ctrl+K**: a search box opens. Type `ale` and press Enter.
4. Open the shop name (top left) for **Language** (English / አማርኛ), **Calendar** (Gregorian / Ethiopian), **Theme** (Same as the device / Light / Dark) and **Sign out**.
5. Make the window narrow (see "Seeing it as a phone" below): the sidebar becomes tabs at the bottom.

**As a till (cashier or manager with a PIN)**
1. Sign out first. On the sign-in page type the **code** `dev:seed` printed, any device name (for example Counter 1) and press **Connect**.
2. Pick **Demo Cashier** and enter the PIN **7391** (Demo Manager: **4829**). Wrong PINs show a message; five wrong in a row lock the person and the till for 15 minutes, and raise an alert you can see as the owner.
3. You are in the till: the header names the device and the cashier; tabs **Sell, Today, Parked, More**. The sale screen itself is the next phase, so these pages say so.
4. **Lock** returns to the PIN screen. Leave the till alone for 3 minutes and it locks itself and says why.
5. As the manager, open **More**, then **Open the admin app**. A cashier sees only what a cashier may: no Alerts page.

Things that are **not built yet** (so do not look for them): selling, products, stock, payments, customers, reports, the staff / devices / settings screens, signing in with an email or Google account. They are in the plan, in that order.

## Seeing it as a phone

In Chrome: press **F12**, then the small phone/tablet icon (or Ctrl+Shift+M), and choose a phone such as "Pixel 7" or set the width to 360. The layout is designed for 360px first.

## If something goes wrong

| Symptom | Fix |
|---|---|
| `Cannot reach the database` / commands fail | Docker Desktop is not running. Open it, wait, then `pnpm db:up`. |
| "This code is not valid or has expired" | Codes last 10 minutes and work once. Run `pnpm dev:seed` for a new one. |
| Port 3000 is busy | Close the other app using it, or stop the earlier `pnpm dev` (Ctrl+C). |
| You want a clean start | `pnpm db:reset`, delete `apps/web/.env.local`, then `pnpm dev:setup` and `pnpm dev:seed` again. |
| `pnpm start` (a production build) says "ALLOW_DEV_SIGN_IN must not be set" | Intended: the developer sign-in can never run in a production build. Use `pnpm dev`, or remove that line from `apps/web/.env.local` for a production run. |
| "Developer sign-in" button missing | `ALLOW_DEV_SIGN_IN=1` is not in `apps/web/.env.local`, or you started a production build (it is refused there on purpose). |

## What the checks cover (for confidence, not for you to run)

`pnpm run ci` runs every automated check. `pnpm --filter @retail/web e2e` drives a real browser (Chromium) on a Pixel 7 and a 1280px desktop through the screens above, including the accessibility scan. GitHub runs both on every push (Actions tab).
