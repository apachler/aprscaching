# Help and FAQ

This page answers the questions players ask most, in a line or two each. Each answer links to the page that
covers it in full.

## Finds and logging

**My find shows Logged. Why?**
Nothing independent placed you at the cache: your phone's location was off, too far away or not allowed, and
no receiving station heard your beacon. A cache can also ask for a higher tier than yours; the result card then
says your find is on record but does not count as verified. See
[How finds are verified](verification.md).

**The app asks for my location. What is it used for?**
When you log a find, the app reads your phone's location once and sends it with the find. That reading makes
the find **Location-verified**. The map also uses it to show where you are and how far a cache is. If you
refuse, the find is still logged, as **Logged**. See [Log a find](log-a-find.md).

**I logged the same cache twice.**
Each cache takes one find from each callsign. The second try shows **You already logged this** and keeps the
first find. See [Log a find](log-a-find.md).

**I have no signal at the cache.**
Log the find as usual. The app saves it, signs it with the time you made it, and sends it when the signal
returns. Make an offline pack of the area before you go. See [Hunting without signal](offline.md).

**My radio log was not acknowledged.**
Your radio gets an acknowledgement only when it numbers the message; check that setting on your radio. The
instance accepts at most ten commands per hour from one callsign and ignores the rest. A message that reached
the instance only over the internet waits under **You → Logs sent over the air** until you tap **Confirm**.
See [Log from your radio](log-a-find.md#log-from-your-radio).

**My radio log was refused.**
Your callsign must be verified on your account before radio logs count. Verify it under
**Settings → Account**. See [Verify your callsign](join.md#verify-your-callsign).

## The map and caches

**Why don't I see a cache my friend sees?**
Your friend may use another instance, which links up with other instances than yours. Caches from instances
your sysop has not vetted stay hidden until you turn on **Include unvetted network data** under
**Search & filter**. Check the **Cache type** filter there as well. See
[Getting to your instance](your-instance.md).

**A cache says "mirrored from" another instance, and I can't log it.**
That cache lives on another instance. Log your find there; it shows on your map once that instance publishes
it. See [Getting to your instance](your-instance.md#instances-and-your-home-instance).

**The "you're near" banner never appears.**
The banner comes from your APRS position: the instance must receive your beacon near the cache while the app
is open. Your phone's location alone does not trigger it. See
[Find a cache](find-a-cache.md#the-youre-near-prompt).

## Your account

**I can't sign in with a passkey on my club's instance.**
Passkeys work only on an `https://` address. On a plain `http://` instance, sign in with the email link, or ask
your sysop for a one-time sign-in link. See [Getting to your instance](your-instance.md#what-works-on-each-way-in).

**I have a new callsign.**
Add it under **Settings → Account → Add a callsign**, verify it, and tap **Set active**. Your past finds stay
with the call you logged them under. See [Several callsigns](account.md#several-callsigns).

**How do I delete my data?**
**Settings → Your data → Erase my account** removes your account, keys and personal data and anonymises your
finds. **Export my data** gives you a full copy first. See [Your data](account.md#your-data).

**I lost my phone.**
Sign in on another device and tap **Settings → Account → Sign out everywhere**. Every session of your account
ends. See [Sign out](account.md#sign-out).

## The instance

**Who runs this instance?**
A ham, a club or a group: its [sysop](../glossary.md#sysop). The app does not name the sysop, so ask the
person or club that gave you the address. See [Getting to your instance](your-instance.md).

**Where do I report a bug?**
First search the manual and the project's existing issues. Then ask in
[GitHub Discussions](https://github.com/apachler/aprscaching/discussions), or open an issue with the bug
template on the same project. A problem with one instance, such as your account or a missing cache, goes to its
sysop.

## Still stuck?

Ask your sysop. Say which instance you use, what you tried, and what the app showed. A screenshot of the
message helps.

## Next

- [Getting to your instance](your-instance.md): the ways in and what works on each.
- [Log a find](log-a-find.md): logging in the app and from your radio.
