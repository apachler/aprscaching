# Off-grid and LAN

An instance needs no internet. This page covers running it on one box or a LAN, with no connection out.

## Where RF comes in

The **ingest box** is never part of the cloud gateway — it always runs on the operator's own equipment, and
`INGEST_URL` can point at a gateway on `localhost`, a LAN box, or a remote cloud. This is what makes off-grid
operation work: run the ingest and a Node gateway on one machine with `INGEST_URL=http://localhost:8787/ingest`
and the whole stack runs with no internet. A cloud VM *may* additionally run an APRS-IS-only ingest for a
baseline global feed, but that is never the only way to get RF in. See
[RF ingest & transports](../radios/rf-ingest.md).

## Off-grid with Docker

Choose the LAN option in `./setup.sh`: `DOMAIN=:80`, `APP_URL=http://<LAN address>`, and the default
`INGEST_URL=http://gateway:8080/ingest` — the full map + RF stack with no internet at all. Without https
there are no passkeys, so members sign in with the operator's
[one-time link](../day-to-day/sign-in-links.md#off-grid-sign-in).

## Next

- [One-time sign-in links](../day-to-day/sign-in-links.md): how members sign in without https.
