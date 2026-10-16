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
   is off, and that nothing unexpected is connected to the old database, at the
   start and again before the copy, after the check and just before the switch.
   We also write down exactly which app version and settings are running today.
2. Confirm Fly has a fresh backup of the old database, taken after the lock.
3. Create the new database (a paid Fly resource).
4. Write down, and have Codex review, the exact two databases, logins and
   database version involved. The copy tool refuses to run against anything
   else, and refuses if something unexpected is connected to the old database.
5. Copy the records. The copy is checked record by record before it is saved.
   If anything differs, nothing is saved.
6. A second, independent check compares old and new again.
7. A tool checks that the app's login on the new database can read and write
   every table it needs.
8. Give the app the new database's login. This is the password change you
   already approved: new login, and the old one is retired later.
9. Start the new app version privately and check sign-in, both companies'
   records, leads, estimates, projects, invoices and scheduling.
10. Open it up for use.

If the connection drops at the exact moment the copy is saved, we may not know
whether it saved. In that case we never just try again. We run the check, which
tells us "saved", "not saved", or "stop and ask Adam".

## How long it takes, and the impact on customers

- On a practice run with test data, the copy and the check took about 10
  seconds. Against Fly, we **estimate** 1 to 5 minutes; this has not been
  measured.
- We estimate the whole session at about 45 to 60 minutes.
- Codex must confirm production's state at the time of the move. A dated note
  from October 16 saw production running, so we cannot assume no one is using
  it. Any users would be locked out for the session.

## If something goes wrong (going back)

- **When we go back:** any failed check, wrong record counts, the app not
  working properly, or you asking us to.
- **Before the new app version has started:** nothing has changed on the new
  database. We put back the old app version, its old settings and the old
  database together. The new app version cannot run on the old database, so
  all three go back as a set.
- **What "going back" means:** the app is left **switched off safely** on the
  old setup. Nothing is lost. We have not yet proven that today's old app
  version runs correctly again, so we will not promise it is back in service
  until it passes its own checks. We will not quote how long this takes until
  it has been rehearsed.
- **Once the new app version has started, even privately:** signing in and
  testing already write to the new database, and real use adds more. Going
  back would lose those changes. So we switch the app off, list every table
  that changed, and ask you to decide for each one:
  - fix the problem on the new database (usually best);
  - carefully copy the new information back first (separate, reviewed work);
  - or knowingly accept losing it, even if it is only test sign-ins.

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
