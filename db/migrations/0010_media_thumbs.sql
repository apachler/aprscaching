-- A small copy of each cache image, stored beside it: the cache page's gallery and an offline pack's
-- thumbnails load it instead of the image as published. The uploader's browser makes it (the instance has
-- no image resizer on every runtime); NULL until one is stored.
ALTER TABLE cache_media ADD COLUMN thumb_key TEXT;
ALTER TABLE cache_media ADD COLUMN thumb_bytes INTEGER;
