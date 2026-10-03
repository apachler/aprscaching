# Licence registers

The **register badge** answers one question: is this callsign listed as a current amateur licence in a public
register? It is a check of **validity**, not of **control**. **✓ you control this call** means the person proved
control of the call ([callsign verification](../run/day-to-day/callsign-verification.md)); the register badge
only says that a national register lists the call.

The badge flags and never blocks. Many countries publish no register, so a call that no imported register
lists reads **"not in a public register"**. That is neutral wording: nothing is refused because of
it, and it is never shown as an error.

| Result | Badge | Meaning |
|--------|-------|---------|
| `licensed` | listed in FCC register | A register lists the call as current. |
| `expired` | listed as expired (FCC) | A register lists the call, but not as currently licensed (expired, cancelled or terminated, or past its expiry date). |
| `unconfirmed` | not in a public register | No imported register lists the call. |

## Sources

Each register is one importer module in `tools/licence/sources/`. A source is implemented only when its data
is public, machine-readable, and its terms allow this use; every format below was checked against the
published file. The operator chooses which ones to import.

| Country | Source | URL | Format | Reuse terms | Status |
|---------|--------|-----|--------|-------------|--------|
| USA | FCC Universal Licensing System, amateur licences (`fcc`) | `https://data.fcc.gov/download/pub/uls/complete/l_amat.zip` (weekly full file) | Zip of pipe-delimited `.dat` files; `HD.dat` carries callsign, status (A/C/E/T), radio service (HA/HV) and expiry (MM/DD/YYYY) | US federal government data, public domain (17 U.S.C. § 105) | Implemented |
| Canada | ISED amateur callsign list (`ised`) | `https://apc-cap.ic.gc.ca/datafiles/amateur_delim.zip` | Zip of `;`-delimited text, callsign in the first field; no expiry (certificates do not expire) | ISED terms: non-commercial reproduction allowed with attribution; commercial redistribution needs ISED's permission | Implemented |
| Australia | ACMA Register of Radiocommunications Licences (`acma`) | `https://web.acma.gov.au/rrl-updates/spectra_rrl.zip` | Zip of CSV tables: `licence.csv` (SV_ID 6 = Amateur, status, expiry) joined to `device_details.csv` (CALL_SIGN) | Licence in the archive (`LICENCE.TXT`): use and derivatives allowed, attribution "Based on Australian Communications and Media Authority information", no reproduction of natural persons' client details | Implemented — repeaters and beacons only; individual operators hold the class licence, which the register does not list |
| Austria | Fernmeldebehörde, Rufzeichenliste österreichischer Amateurfunkstellen (`at`) | Linked from `https://www.fb.gv.at/Funk/amateurfunkdienst.html` | PDF table: callsign, name, location, address, licence class; opted-out holders appear as `*-*-*` with their callsign | Published under § 150 TKG 2021; only the callsign is kept | Implemented (via `pdftotext`) |
| Germany | Bundesnetzagentur Rufzeichenliste (`de`) | `https://data.bundesnetzagentur.de/Bundesnetzagentur/SharedDocs/Downloads/DE/Sachgebiete/Telekommunikation/Unternehmen_Institutionen/Frequenzen/Amateurfunk/Rufzeichenliste/rufzeichenliste_afu.pdf` | PDF, entries `CALL, CLASS, holder…` typeset in columns | Official work under § 5 UrhG; published under AFuG § 6 / AFuV § 15 | Implemented (via `pdftotext`) — holders may object to publication, so absence proves nothing |
| New Zealand | RSM Register of Radio Frequencies | `https://www.rsm.govt.nz` | Online search and an API that needs a registered key; bulk download covers transmit locations only | Not reviewed | Not implemented — no public bulk callsign file |
| Japan | MIC radio station search | `https://www.tele.soumu.go.jp/musen/` | Online search only | — | Not implemented — not machine-readable in bulk |
| Brazil | Anatel | `https://sistemas.anatel.gov.br/sec/` | Online lookup; no amateur dataset on the open-data portal | — | Not implemented — no public dataset found |
| Switzerland | BAKOM / OFCOM | `https://www.bakom.admin.ch` | Online search; no dataset on opendata.swiss | — | Not implemented — no public dataset found |
| Netherlands | RDI (Rijksinspectie Digitale Infrastructuur) callbook | `https://callbook.rdi.nl` | Online search only | — | Not implemented — not machine-readable in bulk |

Adding a register means adding one module under `tools/licence/sources/` (an `id`, a `name`, where to
download it, and a parser that yields callsign, status and expiry) and a row here.

## What is stored

The `licence_registry` table holds, per call and source: the callsign, `licensed` or `expired`, the expiry
date where the register gives one, and the date of the import that wrote it. Nothing else — no name,
address, email or licence class. The register files do contain personal details; the import tool parses
them on the operator's machine and sends only those three fields, so the details never reach the gateway.

These rows are public-register facts about callsigns, not user data, so they are not part of a user's
export or erasure. Signing up or adding a call stores nothing new: the badge is looked up when it is shown.

**Retention:** each import of a source replaces that source's rows. A call missing from the new import is
deleted when the import completes. An import that stops part-way deletes nothing.

## Callsign normalisation

A call is looked up by its home call:

1. Uppercase and trim; drop the SSID (`-9`) and a trailing `*`.
2. Split a portable form on `/` and keep the **longest** part shaped like a callsign — letters and digits,
   at least one digit, ending in a letter, 3–10 characters. On a tie the first part wins.

So `OE/DL1ABC/P`, `DL1ABC/OE` and `dl1abc-7` all look up `DL1ABC`; `VE3/W1AW` and `W1AW/KH6` look up
`W1AW`. A country prefix (`OE`, `VE3`, `KH6`) or an operating suffix (`P`, `M`, `MM`, `QRP`) never matches
the callsign shape.

When several registers list a call, a current listing wins over an expired one, then the latest expiry.

## Attribution

Register data shown by an instance comes from these sources: FCC ULS; ISED Canada (amateur callsign list,
reproduced from `https://ised-isde.canada.ca/site/amateur-radio-operator-certificate-services/en/downloads`);
"Based on Australian Communications and Media Authority information"; Fernmeldebehörde (Austria);
Bundesnetzagentur (Germany). An operator who imports the ISED list for a commercial service needs ISED's
permission.

## Next

- [Licence registers](../run/day-to-day/licence-registers.md): importing them.
