"""Account isolation, session lifecycle, CSRF, legacy claim, SMTP reset, and KDF policy."""
import copy
import hashlib
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit, parse_qs
from auth import Auth, AuthError, RateLimiter, SESSION_TTL, RESET_TTL, password_hash, digest
from server import Store, LocalServer, empty_state, ConflictError

PASSWORD='Uma-senha-de-teste-123'
NEW_PASSWORD='Outra-senha-de-teste-456'
def fast_hash(password,salt):
    # Test-only injection: runtime cannot select a weaker KDF.
    return hashlib.sha256((salt+password).encode()).hexdigest()

class AuthTests(unittest.TestCase):
    def setUp(self):
        self.patch=patch('auth.password_hash',fast_hash)
        self.patch.start()
        self.temp=tempfile.TemporaryDirectory()
        self.store=Store(Path(self.temp.name)/'app.sqlite')
        self.now=1000000
        self.sent=[]
        self.auth=Auth(self.store,empty_state,clock=lambda:self.now,environ={})

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def register(self,email='first@example.test',importing=False):
        return self.auth.register({'email':email,'password':PASSWORD,'firstName':'Pessoa','lastName':'Teste','importLegacy':importing},'127.0.0.1')

    def test_accounts_start_empty_and_are_isolated(self):
        a,token=self.register()
        b,_=self.register('second@example.test')
        aid,bid=a['user']['id'],b['user']['id']
        state=self.store.get(aid)
        self.assertEqual(state['movements'],[])
        state['profile']['firstName']='Alterado'
        self.store.put(state,aid)
        self.assertEqual(self.store.get(bid)['profile']['firstName'],'Pessoa')
        self.assertEqual(self.store.get(bid)['revision'],0)
        with self.assertRaises(ConflictError):
            self.store.put(state,aid)

    def test_passwords_and_session_tokens_are_hashed_at_rest(self):
        account,token=self.register()
        with self.store.connect() as db:
            row=db.execute('SELECT salt,password_hash FROM users').fetchone()
            session=db.execute('SELECT token_hash FROM sessions').fetchone()[0]
        self.assertNotEqual(row[1],PASSWORD)
        self.assertEqual(len(row[0]),32)
        self.assertEqual(session,digest(token))
        self.assertNotEqual(session,token)
        self.assertEqual(self.auth.session(token)['user'],account['user'])

    def test_normalized_email_and_generic_login_failure(self):
        account,_=self.register(' Person@Example.test ')
        result,_=self.auth.login({'email':'PERSON@EXAMPLE.TEST','password':PASSWORD},'local')
        self.assertEqual(result['user'],account['user'])
        errors=[]
        for email in ('person@example.test','unknown@example.test'):
            with self.assertRaises(AuthError) as exc:
                self.auth.login({'email':email,'password':'wrong'},'local')
            errors.append((exc.exception.status,str(exc.exception)))
        self.assertEqual(errors[0],errors[1])

    def test_session_expiry_and_logout(self):
        _,token=self.register()
        self.auth.logout(self.auth.session(token))
        self.assertIsNone(self.auth.session(token))
        _,token=self.auth.login({'email':'first@example.test','password':PASSWORD},'local')
        self.now+=SESSION_TTL
        self.assertIsNone(self.auth.session(token))

    def test_password_rotation_revokes_all_old_sessions(self):
        _,first=self.register()
        _,second=self.auth.login({'email':'first@example.test','password':PASSWORD},'local')
        account,new=self.auth.change_password(self.auth.session(first),{'currentPassword':PASSWORD,'newPassword':NEW_PASSWORD},'local')
        self.assertIsNone(self.auth.session(first))
        self.assertIsNone(self.auth.session(second))
        self.assertEqual(self.auth.session(new)['csrfToken'],account['csrfToken'])
        with self.assertRaises(AuthError):
            self.auth.login({'email':'first@example.test','password':PASSWORD},'local')
        self.auth.login({'email':'first@example.test','password':NEW_PASSWORD},'local')

    def test_legacy_import_optin_and_original_retained(self):
        legacy=self.store.get()
        account,_=self.register(importing=True)
        copied=self.store.get(account['user']['id'])
        self.assertEqual(copied['movements'],legacy['movements'])
        self.assertEqual(self.store.get(),legacy)
        copied['movements']=[]
        self.store.put(copied,account['user']['id'])
        self.assertEqual(self.store.get(),legacy)
        self.assertFalse(self.auth.legacy_available())
        with self.assertRaises(AuthError):
            self.register('second@example.test',True)

    def test_import_claim_is_atomic_between_first_accounts(self):
        barrier=threading.Barrier(2)
        results=[]
        def claim(email):
            barrier.wait()
            try:
                self.register(email,True)
                results.append('ok')
            except AuthError as exc:
                results.append(exc.status)
        workers=[threading.Thread(target=claim,args=(f'{i}@example.test',)) for i in range(2)]
        for worker in workers:worker.start()
        for worker in workers:worker.join()
        self.assertCountEqual(results,['ok',409])

    def test_public_server_never_exposes_or_imports_legacy(self):
        public=Auth(self.store,empty_state,local_mode=False,environ={})
        self.assertFalse(public.legacy_available())
        with self.assertRaises(AuthError) as exc:
            public.register({'email':'first@example.test','password':PASSWORD,'firstName':'Teste','importLegacy':True},'local')
        self.assertEqual(exc.exception.status,403)

    def test_unconfigured_reset_reports_unavailable(self):
        self.register()
        self.assertFalse(self.auth.password_reset_available)
        with self.assertRaises(AuthError) as exc:
            self.auth.forgot({'email':'first@example.test'},'local','http://127.0.0.1:4173')
        self.assertEqual(exc.exception.status,503)
        self.assertEqual(self.sent,[])

    def setup_mail(self):
        self.auth.env={'BRENO_SMTP_HOST':'smtp.example.test','BRENO_SMTP_FROM':'account@example.test'}
        self.auth.mailer=lambda email,link:self.sent.append((email,link))

    def reset_token(self):
        return parse_qs(urlsplit(self.sent[-1][1]).fragment)['token'][0]

    def test_reset_one_use_revokes_sessions_and_hides_unknown_email(self):
        _,session=self.register()
        self.setup_mail()
        known=self.auth.forgot({'email':'first@example.test'},'local','https://finance.example.test')
        unknown=self.auth.forgot({'email':'missing@example.test'},'local','https://finance.example.test')
        self.assertEqual(known,unknown)
        self.assertEqual(len(self.sent),1)
        token=self.reset_token()
        self.assertNotIn(token,urlsplit(self.sent[0][1]).query)
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT token_hash FROM password_resets').fetchone()[0],digest(token))
        self.auth.reset({'token':token,'password':NEW_PASSWORD},'local')
        self.assertIsNone(self.auth.session(session))
        with self.assertRaises(AuthError):
            self.auth.reset({'token':token,'password':PASSWORD},'local')
        self.auth.login({'email':'first@example.test','password':NEW_PASSWORD},'local')

    def test_reset_expiration_and_delivery_failure(self):
        self.register();self.setup_mail()
        self.auth.forgot({'email':'first@example.test'},'local','https://finance.example.test')
        token=self.reset_token();self.now+=RESET_TTL
        with self.assertRaises(AuthError):
            self.auth.reset({'token':token,'password':NEW_PASSWORD},'local')
        def fail(*args):raise RuntimeError('delivery failure containing sensitive context')
        self.auth.mailer=fail
        with self.assertRaises(AuthError) as exc:
            self.auth.forgot({'email':'first@example.test'},'local','https://finance.example.test')
        self.assertNotIn('sensitive',str(exc.exception))
        with self.store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM password_resets').fetchone()[0],0)

    def test_rate_limit_and_bounded_memory(self):
        limiter=RateLimiter(clock=lambda:self.now,capacity=3)
        limiter.take('a',1)
        with self.assertRaises(AuthError) as exc:limiter.take('a',1)
        self.assertEqual(exc.exception.status,429)
        for key in range(20):limiter.take(key,1)
        self.assertEqual(len(limiter.entries),3)
        self.now+=901;limiter.take(19,1)

    def test_password_length_boundaries(self):
        for password in ('short','x'*129,None):
            with self.assertRaises(AuthError):
                self.auth.register({'email':'valid@example.test','password':password,'firstName':'A'},'local')


class KDFTests(unittest.TestCase):
    def test_production_scrypt_parameters(self):
        with patch('auth.hashlib.scrypt',return_value=b'x'*32) as scrypt:
            result=password_hash(PASSWORD,'ab'*16)
        self.assertEqual(len(result),64)
        self.assertEqual(scrypt.call_args.kwargs['n'],131072)
        self.assertEqual(scrypt.call_args.kwargs['r'],8)
        self.assertEqual(scrypt.call_args.kwargs['p'],1)
        self.assertEqual(scrypt.call_args.kwargs['maxmem'],256*1024*1024)

    @unittest.skipUnless(hasattr(hashlib,'scrypt'),'Use Python com OpenSSL/scrypt')
    def test_real_scrypt_hash_is_deterministic_and_salted(self):
        a=password_hash(PASSWORD,'ab'*16)
        self.assertEqual(a,password_hash(PASSWORD,'ab'*16))
        self.assertNotEqual(a,password_hash(PASSWORD,'cd'*16))


class AuthHTTPTests(unittest.TestCase):
    def setUp(self):
        self.patch=patch('auth.password_hash',fast_hash);self.patch.start()
        self.temp=tempfile.TemporaryDirectory()
        self.store=Store(Path(self.temp.name)/'app.sqlite')
        self.auth=Auth(self.store,empty_state,environ={})
        try:self.server=LocalServer(('127.0.0.1',0),self.store,auth=self.auth)
        except PermissionError:
            self.patch.stop();self.temp.cleanup();self.skipTest('Sem sockets no sandbox')
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.port=self.server.server_port

    def tearDown(self):
        if hasattr(self,'server'):
            self.server.shutdown();self.server.server_close();self.thread.join()
        self.patch.stop();self.temp.cleanup()

    def request(self,method,path,data=None,headers=None):
        merged={'Content-Type':'application/json',**(headers or {})}
        body=json.dumps(data) if data is not None else None
        connection=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        connection.request(method,path,body,merged)
        response=connection.getresponse();content=response.read()
        result=response.status,dict(response.getheaders()),json.loads(content) if content and response.getheader('Content-Type','').startswith('application/json') else content
        connection.close();return result

    def register(self,email='http@example.test'):
        code,headers,body=self.request('POST','/api/auth/register',{'email':email,'password':PASSWORD,'firstName':'Teste'})
        self.assertEqual(code,201)
        return body,{'Cookie':headers['Set-Cookie'].split(';')[0],'X-CSRF-Token':body['csrfToken'],'X-Account-Id':body['user']['id']}

    def test_unauthenticated_state_blocked_and_session_public(self):
        for method in ('GET','PUT'):
            code,_,body=self.request(method,'/api/state',{} if method=='PUT' else None)
            self.assertEqual(code,401);self.assertEqual(body['code'],'session_expired')
        code,_,body=self.request('GET','/api/auth/session')
        self.assertEqual(code,200);self.assertIsNone(body['user'])
        self.assertFalse(body['passwordResetAvailable'])

    def test_cookie_flags_csrf_and_longpoll_revision(self):
        code,headers,account=self.request('POST','/api/auth/register',{'email':'http@example.test','password':PASSWORD,'firstName':'Teste'})
        self.assertEqual(code,201)
        cookie=headers['Set-Cookie']
        self.assertIn('HttpOnly',cookie);self.assertIn('SameSite=Lax',cookie)
        auth={'Cookie':cookie.split(';')[0],'X-CSRF-Token':account['csrfToken'],'X-Account-Id':account['user']['id']}
        code,headers,state=self.request('GET','/api/state',headers=auth)
        self.assertEqual(headers['X-Account-Id'],account['user']['id'])
        code,_,body=self.request('PUT','/api/state',state,{'Cookie':auth['Cookie']})
        self.assertEqual(code,403);self.assertEqual(body['code'],'csrf_invalid')
        code,headers,body=self.request('GET','/api/state?since=0',headers=auth)
        self.assertEqual(code,304);self.assertEqual(headers['X-Account-Id'],account['user']['id'])
        code,_,body=self.request('PUT','/api/state',state,auth)
        self.assertEqual(code,200);self.assertEqual(body['revision'],1)
        code,_,_=self.request('PUT','/api/state',state,auth)
        self.assertEqual(code,409)

    def test_account_switch_never_overwrites_new_account(self):
        first,old=self.register('first@example.test')
        second,new=self.register('second@example.test')
        stale={**new,'X-Account-Id':first['user']['id']}
        for method in ('GET','PUT'):
            code,_,body=self.request(method,'/api/state',empty_state() if method=='PUT' else None,stale)
            self.assertEqual(code,409);self.assertEqual(body['code'],'account_changed')
        self.assertEqual(self.store.get(second['user']['id'])['revision'],0)
        code,_,_=self.request('POST','/api/auth/logout',{},new)
        self.assertEqual(code,200)
        self.assertEqual(self.request('GET','/api/state',headers=new)[0],401)
        self.assertEqual(self.request('GET','/api/state',headers=old)[0],200)

    def test_public_origin_host_and_secure_cookie(self):
        self.server.public_origin='https://finance.example.test';self.auth.local_mode=False
        code,_,_=self.request('GET','/api/auth/session')
        self.assertEqual(code,403)
        headers={'Host':'finance.example.test','Origin':'https://finance.example.test'}
        code,_,body=self.request('GET','/api/auth/session',headers=headers)
        self.assertEqual(code,200);self.assertFalse(body['legacyAvailable'])
        code,response,_=self.request('POST','/api/auth/register',{'email':'public@example.test','password':PASSWORD,'firstName':'Teste'},headers)
        self.assertEqual(code,201);self.assertIn('Secure',response['Set-Cookie'])
        bad={**headers,'Origin':'https://evil.example.test'}
        self.assertEqual(self.request('POST','/api/auth/login',{},bad)[0],403)
        # Forwarded headers cannot override canonical Host verification.
        self.assertEqual(self.request('GET','/api/auth/session',headers={'X-Forwarded-Host':'finance.example.test'})[0],403)

if __name__=='__main__':unittest.main()
