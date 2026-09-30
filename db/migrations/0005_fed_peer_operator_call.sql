-- The base callsign ARDC verified for a peer added over 44net (its <call>.ampr.org zone carries the
-- binding). The corroboration quorum counts peers by operator: the registry's operator when it names one,
-- else this call, else the signing key — so several instances of one callsign are one voice.
ALTER TABLE fed_peers ADD COLUMN operator_call TEXT;
