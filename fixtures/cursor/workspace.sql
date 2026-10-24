CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
INSERT INTO ItemTable VALUES ('composer.composerData', '{"allComposers": [{"type": "head", "composerId": "cccccccc-0000-4000-8000-000000000001", "createdAt": 1768471200000}]}');
