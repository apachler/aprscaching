-- Federation over FBB (FED_BBS) travels only to and from the forwarding partners the sysop marks for it, once
-- the partner's sysop has agreed to carry machine data. Off for every partner unless turned on.
ALTER TABLE bbs_partners ADD COLUMN federation INTEGER NOT NULL DEFAULT 0;
