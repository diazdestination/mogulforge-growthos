# Moving GrowthOS to its new database: one-page plan for Adam

## What happens

GrowthOS keeps its customer records in a database hosted by Fly. That database
runs on Fly's older generation. We will create a brand-new database on Fly's
current generation and copy everything into it. That is fewer than 200 records,
in the layout the new app version expects. Then we start the new app version
on the new database.

The old database is only read, never changed. It stays exactly as it is, as our
safety net.

Steps, in order:

1. **Lock the app off.** Stop it and switch off automatic wake-up, so no one and
   nothing can change the old database during the move. We check that it really
   is off, and that nothing is connected to the old database, before the copy,
   after the check and just before the switch. We also write down exactly which
   app version and settings are running today, so we can go back to them.
2. Confirm Fly has a fresh backup of the old database, taken after the lock.
3. Create the new database (a paid Fly resource).
4. Copy the records. The copy is checked record by record before it is saved.
   If anything differs, nothing is saved. The tool only works on the two exact
   databases we name in advance, and refuses anything else.
5. A second, independent check compares old and new again.
6. Check that the app's login on the new database can read and write
   everything it needs.
7. Give the app the new database's login. This is the password change you
   already approved: new login, and the old one is retired later.
8. Start the new app version privately and check sign-in, both companies'
   records, leads, estimates, projects, invoices and scheduling.
9. Open it up for use.

If the connection drops at the exact moment the copy is saved, we may not know
whether it saved. In that case we never just try again. We run the check, which
tells us "saved", "not saved", or "stop and ask Adam".

## How long it takes, and the impact on customers

- The copy and the check took about 10 seconds on a practice run with test data.
  Over the internet to Fly, expect 1 to 5 minutes.
- The whole session, including creating the database and the checks, takes
  about 45 to 60 minutes.
- Production is switched off today and is not serving customers, so the impact
  on customers is effectively none.

## If something goes wrong (going back)

- **When we go back:** any failed check, wrong record counts, the app not
  working properly, or you asking us to.
- **How:** switch the app off again, then put back **the old app version, its old
  settings and the old database** together. The new app version cannot run on
  the old database, so all three go back as a set. Before the app is open for
  use, this takes about **5 to 10 minutes** and loses nothing, because the old
  database was never touched.
- **After the app is open for use**, people may have entered new information
  that exists only in the new database. Going back would lose it. So we do not
  go back automatically. We switch the app off, list exactly what changed, and
  ask you to choose:
  - fix the problem on the new database (usually best);
  - carefully copy the new information back first (separate, reviewed work);
  - or knowingly accept losing it.

## Cost

There is a monthly charge for the new database. Codex will confirm it from
Fly's current pricing before asking you. While both exist, we briefly pay for
the old and the new database. The old one can be retired after you accept the
move.

## What you approve (one approval)

- Creating the new Fly database at the price Codex quotes.
- Running the move and switching the app to it, including the new login.
- Keeping the old database, old app version and old settings untouched as the
  fallback until you accept. Retiring the old login, and later the old
  database, comes back to you for a yes.
