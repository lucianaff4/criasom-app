CREATE TABLE IF NOT EXISTS forum_profiles(user_id TEXT PRIMARY KEY REFERENCES users(id),display_name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS forum_posts(id TEXT PRIMARY KEY,author_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,space TEXT NOT NULL,category TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,links_json TEXT NOT NULL,tags_json TEXT NOT NULL,module_id TEXT NOT NULL,practice_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,activity_at INTEGER NOT NULL,deleted_at INTEGER,UNIQUE(author_id,request_id));
CREATE INDEX IF NOT EXISTS forum_space_activity ON forum_posts(space,deleted_at,activity_at,id);
CREATE INDEX IF NOT EXISTS forum_module_activity ON forum_posts(module_id,deleted_at,activity_at);
CREATE TABLE IF NOT EXISTS forum_comments(id TEXT PRIMARY KEY,post_id TEXT NOT NULL REFERENCES forum_posts(id),author_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,body TEXT NOT NULL,links_json TEXT NOT NULL,created_at INTEGER NOT NULL,deleted_at INTEGER,UNIQUE(author_id,request_id));
CREATE INDEX IF NOT EXISTS forum_post_comments ON forum_comments(post_id,created_at,id);

CREATE TABLE IF NOT EXISTS forum_avatars(user_id TEXT PRIMARY KEY REFERENCES users(id),jpeg_base64 TEXT NOT NULL,version TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS forum_acceptances(user_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL,version TEXT NOT NULL,document_hash TEXT NOT NULL,document_json TEXT NOT NULL,accepted_at INTEGER NOT NULL,adult_declared INTEGER NOT NULL,PRIMARY KEY(user_id,kind,version,document_hash));
CREATE TABLE IF NOT EXISTS forum_reports(id TEXT PRIMARY KEY,post_id TEXT NOT NULL REFERENCES forum_posts(id),reporter_id TEXT NOT NULL REFERENCES users(id),reason TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL,UNIQUE(post_id,reporter_id));

CREATE TABLE IF NOT EXISTS forum_moderators(user_id TEXT PRIMARY KEY REFERENCES users(id));
CREATE TABLE IF NOT EXISTS forum_hidden(post_id TEXT PRIMARY KEY REFERENCES forum_posts(id),moderator_id TEXT NOT NULL REFERENCES users(id),reason TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS forum_blocks(user_id TEXT PRIMARY KEY REFERENCES users(id),active INTEGER NOT NULL,reason TEXT NOT NULL,moderator_id TEXT NOT NULL REFERENCES users(id),updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS forum_moderation_actions(id TEXT PRIMARY KEY,moderator_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(moderator_id,request_id));
CREATE TABLE IF NOT EXISTS forum_report_snapshots(report_id TEXT PRIMARY KEY REFERENCES forum_reports(id),snapshot_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS forum_images(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),request_id TEXT NOT NULL,request_hash TEXT NOT NULL,post_id TEXT REFERENCES forum_posts(id),jpeg_base64 TEXT NOT NULL,version TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,created_at INTEGER NOT NULL,position INTEGER NOT NULL,UNIQUE(owner_id,request_id));
CREATE INDEX IF NOT EXISTS forum_images_post ON forum_images(post_id,position);
CREATE INDEX IF NOT EXISTS forum_reports_queue ON forum_reports(status,created_at,id);
