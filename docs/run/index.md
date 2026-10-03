# Is running an instance for me?

An instance is a complete APRScaching site: the map, the game, the Shack and a radio gateway. A club or a
single operator can run one on a Raspberry Pi at home, a mini-PC, a small cloud server, a phone or entirely
off-grid. Instances can link up, so caches and radio confirmations are shared across the network. You do not
need your own instance to play: you can join an existing one.

This section is for the **sysop**, the licensed operator who runs the instance. It assumes you know Linux,
Docker, DNS and networking; it never assumes you know the code.

## What you run

An instance has two parts that deploy separately:

- the **gateway**: the API and the data. It runs on your box, as a desktop app, or on Cloudflare.
- the **RF ingest**: the program that carries what your radios hear into the gateway. It always runs on your
  own equipment, next to the radio.

`deploy/aprscaching` sets up, checks and maintains every shape with the same commands:
[The deploy/aprscaching command](day-to-day/helper-command.md).

## Your journey

1. [Choose a shape](choose-a-shape.md): Self-host, Desktop, Pocket or the Cloudflare split.
2. Install it: [Self-host with Docker](install/self-host-docker.md) (recommended),
   [Self-host without Docker](install/self-host-bare-metal.md), [Desktop](install/desktop.md),
   [Cloudflare split](install/cloudflare-split.md) or [Pocket](install/pocket.md).
3. [Your first hour](first-hour.md): from "it answers" to a public, verified, backed-up instance.
4. Connect radios: start with the [quick starts](radios/quick-starts.md). Hams can also
   [lend their receivers](radios/lend-a-receiver.md) to your instance.
5. Networks: [off-grid](networks/off-grid.md), [Cloudflare](networks/cloudflare.md),
   [44Net](networks/44net.md), [HAMNET](networks/hamnet.md).
6. [Join the network](federation/index.md): federation with other instances.
7. Day to day: [admin](day-to-day/index.md), [backups](day-to-day/backups.md), [updates](day-to-day/updates.md).
8. [A public instance's duties](compliance/index.md), and the rules for
   [automatic stations on the air](compliance/on-air-stations.md) before you transmit.

## Next

- [Choose a shape](choose-a-shape.md).
