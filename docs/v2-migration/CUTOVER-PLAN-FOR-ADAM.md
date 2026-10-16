# Moving GrowthOS to its new database: one-page plan for Adam

## What happens

GrowthOS keeps its customer records in a database hosted by Fly. That database
runs on Fly's older generation. We will create a brand-new database on Fly's
current generation and copy everything into it. That is fewer than 200 records,
in the layout the current app expects. Then we point the app at the new database.

The old database is only read, never changed. It stays exactly as it is, as our
safety net.

Steps, in order:

1. Make sure the app stays switched off, so nothing changes during the move.
2. Confirm Fly has a fresh backup of the old database.
3. Create the new database (a paid Fly resource).
4. Copy the records. The copy is checked record by record before it is saved.
   If anything differs, nothing is saved.
5. A second, independent check compares old and new again.
6. Give the app the new database's login. This is the password change you
   already approved: new login, and the old one is retired later.
7. Start the app privately and check sign-in, both companies' records, leads,
   estimates, projects, invoices and scheduling.
8. Open it up for use.

## How long it takes, and the impact on customers

- The copy and the check took about 9 seconds on a practice run with test data.
  Over the internet to Fly, expect 1 to 5 minutes.
- The whole session, including creating the database and the checks, takes
  about 45 to 60 minutes.
- Production is switched off today and is not serving customers, so the impact
  on customers is effectively none.

## If something goes wrong (rollback)

- **When we roll back:** any failed check, wrong record counts, the app not
  working properly, or you asking us to.
- **How:** point the app back at the old database and restart it. This takes
  about **2 to 5 minutes**.
- Nothing is lost, because the old database was never touched.
- One caveat: once the app is open for use, anything entered on the new
  database is not copied back automatically.

## Cost

There is a monthly charge for the new database. Codex will confirm it from
Fly's current pricing before asking you. While both exist, we briefly pay for
the old and the new database. The old one can be retired after you accept the
move.

## What you approve (one approval)

- Creating the new Fly database at the price Codex quotes.
- Running the move and switching the app to it, including the new login.
- Keeping the old database untouched as the fallback until you accept. Retiring
  the old login, and later the old database, comes back to you for a yes.
