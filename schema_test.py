from pathlib import Path
import sqlite3, unittest

ROOT=Path(__file__).resolve().parents[1]
class Schema(unittest.TestCase):
    def setUp(self):
        self.db=sqlite3.connect(':memory:')
        self.db.executescript((ROOT/'sql/sqlite.sql').read_text(encoding='utf-8'))
        self.db.execute('INSERT INTO users VALUES(?,?,?,?)',('alice','alice@example.invalid',100,100))
        self.db.execute('INSERT INTO users VALUES(?,?,?,?)',('bob','bob@example.invalid',100,100))
    def tearDown(self): self.db.close()
    def test_identity_and_session_integrity(self):
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute('INSERT INTO users VALUES(?,?,?,?)',('second','alice@example.invalid',100,100))
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?)',('hash','missing','csrf',100,200,None))
    def test_one_event_and_one_source(self):
        self.db.execute('INSERT INTO purchase_sources VALUES(?,?,?,?,?,?,?)',('txn','alice@example.invalid','synthetic','test','{}',0,None))
        self.db.execute('INSERT INTO purchase_events VALUES(?,?,?,?,?)',('evt','hash','txn','applied',100))
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute('INSERT INTO purchase_events VALUES(?,?,?,?,?)',('evt','otherhash','txn','applied',100))
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute('INSERT INTO purchase_sources VALUES(?,?,?,?,?,?,?)',('txn','bob@example.invalid','other','test','{}',0,None))
    def test_personal_state_version_and_account_partition(self):
        for user in ['alice','bob']: self.db.execute('INSERT INTO user_state VALUES(?,?,?,?,?)',(user,'repertoire',1,'{}',100))
        updated=self.db.execute('UPDATE user_state SET revision=revision+1,data_json=? WHERE user_id=? AND area=? AND revision=?',('{"favorites":["one"]}','alice','repertoire',1))
        self.assertEqual(updated.rowcount,1)
        stale=self.db.execute('UPDATE user_state SET revision=revision+1,data_json=? WHERE user_id=? AND area=? AND revision=?',('{"favorites":[]}','alice','repertoire',1))
        self.assertEqual(stale.rowcount,0)
        self.assertEqual(self.db.execute('SELECT data_json FROM user_state WHERE user_id=?',('bob',)).fetchone()[0],'{}')
    def test_code_consumed_once_and_expiry(self):
        self.db.execute('INSERT INTO auth_challenges VALUES(?,?,?,?,?,?,?,?,?)',('challenge','alice@example.invalid','h','b','r',100,200,0,None))
        for expected in [1,0]:
            row=self.db.execute('UPDATE auth_challenges SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>?',(150,'challenge',150))
            self.assertEqual(row.rowcount,expected)
        self.assertEqual(self.db.execute('UPDATE auth_challenges SET attempts=attempts+1 WHERE id=? AND expires_at>?',('challenge',200)).rowcount,0)
    def test_outbox_idempotency_and_atomic_rollback(self):
        self.db.commit()
        try:
            with self.db:
                self.db.execute('INSERT INTO email_outbox VALUES(?,?,?,?,?)',('a','auth:a','ciphertext','pending',100))
                self.db.execute('INSERT INTO email_outbox VALUES(?,?,?,?,?)',('b','auth:a','ciphertext','pending',100))
        except sqlite3.IntegrityError: pass
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM email_outbox').fetchone()[0],0)
    def test_atomic_quota_and_teacher_assignment(self):
        self.db.execute('INSERT INTO auth_quotas VALUES(?,?,?)',('bucket',0,0))
        results=[self.db.execute('UPDATE auth_quotas SET hits=hits+1 WHERE bucket_hash=? AND hits<?',('bucket',3)).rowcount for _ in range(6)]
        self.assertEqual(results,[1,1,1,0,0,0])
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute('INSERT INTO object_teacher_access VALUES(?,?)',('missing','alice'))
        self.db.execute('INSERT INTO protected_objects VALUES(?,?,?,?,?,?,?,?)',('obj','key','private','application/pdf','["app"]','teacher','alice','active'))
        self.db.execute('INSERT INTO object_teacher_access VALUES(?,?)',('obj','bob'))
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute('INSERT INTO object_teacher_access VALUES(?,?)',('obj','bob'))

if __name__=='__main__': unittest.main(verbosity=2)
