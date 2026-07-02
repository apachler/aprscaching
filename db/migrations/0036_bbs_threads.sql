-- SPDX-License-Identifier: AGPL-3.0-or-later
-- FBB-style BBS uplift (docs/25 P2): a thread tree on the message base so replies (SR) chain into
-- conversations, and 'T' (NTS traffic) joins the existing 'P'/'B' typing (type stays free TEXT). reply_to
-- points at the parent message; thread_id is the conversation root (a root message's thread_id = its own
-- id). MID/BID is the existing bbs_messages.bid (unique, deduped across peers). All three runtimes.
ALTER TABLE bbs_messages ADD COLUMN reply_to  INTEGER;
ALTER TABLE bbs_messages ADD COLUMN thread_id INTEGER;
CREATE INDEX idx_bbs_thread ON bbs_messages (thread_id, posted_at);
