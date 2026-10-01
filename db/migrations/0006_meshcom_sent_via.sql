-- The relays a MeshCom node named in its latest message (its --via list), for display: the sender's plan,
-- never the route taken and never a trust input. sent_via is a JSON array of callsigns, NULL when the latest
-- message named none; msg_at is when the node's latest message was seen, NULL while none has been, so "no
-- via list" and "not known yet" stay apart (the operator's own node's Via setting reads from its echoes).
ALTER TABLE meshcom_nodes ADD COLUMN sent_via TEXT;
ALTER TABLE meshcom_nodes ADD COLUMN msg_at INTEGER;
