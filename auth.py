"""Autenticação de contas, sessões opacas e recuperação SMTP (biblioteca padrão)."""
from __future__ import annotations
import hashlib
import hmac
import json
import os
import re
import secrets
import smtplib
import ssl
import threading
import time
from collections import OrderedDict, deque
from email.message import EmailMessage
from urllib.parse import urlencode

SESSION_TTL = 7 * 24 * 60 * 60
RESET_TTL = 30 * 60
COOKIE_NAME = 'breno_session'
_HASH_SLOTS = threading.BoundedSemaphore(2)

class AuthError(Exception):
    def __init__(self, message, status=400):
        self.status, self.message = status, message
        super().__init__(message)


def normalize_email(value):
    if not isinstance(value, str):
        raise AuthError('Informe um e-mail válido.')
    value = value.strip().casefold()
    if len(value) > 254 or not re.fullmatch(r'[^@\s]{1,64}@[^@\s]+\.[^@\s]+', value):
        raise AuthError('Informe um e-mail válido.')
    return value


def check_password(value):
    if not isinstance(value, str) or not 10 <= len(value) <= 128:
        raise AuthError('A senha precisa ter entre 10 e 128 caracteres.')
    return value


def digest(token):
    return hashlib.sha256(token.encode('utf-8')).hexdigest()


def password_hash(password, salt):
    if not hasattr(hashlib, 'scrypt'):
        raise RuntimeError('Este Python não tem suporte a scrypt. Execute com Python e OpenSSL completos.')
    with _HASH_SLOTS:
        return hashlib.scrypt(password.encode('utf-8'), salt=bytes.fromhex(salt), n=131072, r=8, p=1, maxmem=256*1024*1024, dklen=32).hex()


class RateLimiter:
    """Fixed-size, thread-safe sliding windows; actual socket IP, never proxy headers."""
    def __init__(self, clock=time.time, capacity=4096):
        self.clock, self.capacity = clock, capacity
        self.entries = OrderedDict()
        self.lock = threading.Lock()

    def take(self, key, limit, window=900):
        now = self.clock()
        with self.lock:
            events = self.entries.pop(key, deque())
            while events and events[0] <= now-window:
                events.popleft()
            allowed = len(events) < limit
            if allowed:
                events.append(now)
            self.entries[key] = events
            while len(self.entries) > self.capacity:
                self.entries.popitem(last=False)
            if not allowed:
                raise AuthError('Muitas tentativas. Aguarde alguns minutos e tente novamente.', 429)


class Auth:
    def __init__(self, store, empty_state, local_mode=True, clock=time.time, environ=None, mailer=None):
        self.store, self.empty_state, self.local_mode, self.clock = store, empty_state, local_mode, clock
        self.env = os.environ if environ is None else environ
        self.mailer = mailer or self.send_mail
        self.limiter = RateLimiter(clock)
        self.dummy_salt = secrets.token_hex(16)
        self.dummy_hash = password_hash('dummy-password-never-valid', self.dummy_salt)
        with store.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL,
                    password_hash TEXT NOT NULL, created_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS user_state (
                    user_id TEXT PRIMARY KEY REFERENCES users(id), revision INTEGER NOT NULL, document TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    csrf_token TEXT NOT NULL, expires_at REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
                CREATE TABLE IF NOT EXISTS password_resets (
                    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);
            ''')

    @property
    def password_reset_available(self):
        return bool(self.env.get('BRENO_SMTP_HOST') and self.env.get('BRENO_SMTP_FROM'))

    def legacy_available(self):
        if not self.local_mode:
            return False
        with self.store.connect() as db:
            return db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0

    def throttle(self, action, ip, email=''):
        self.limiter.take(('ip', action, ip), 30 if action == 'login' else 12)
        if email:
            # Only hashes are retained in limiter keys, and entry count is bounded.
            self.limiter.take(('email', action, digest(email)), 10 if action == 'login' else 5)

    def session(self, token):
        if not isinstance(token, str) or not 20 <= len(token) <= 200:
            return None
        with self.store.connect() as db:
            row = db.execute('SELECT s.user_id,u.email,s.csrf_token,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=?', (digest(token),)).fetchone()
            if not row or row[3] <= self.clock():
                if row:
                    db.execute('DELETE FROM sessions WHERE token_hash=?', (digest(token),))
                return None
        return {'user': {'id': row[0], 'email': row[1]}, 'csrfToken': row[2], 'tokenHash': digest(token)}

    def _new_session(self, db, user_id, email):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        db.execute('DELETE FROM sessions WHERE expires_at<=?', (self.clock(),))
        # Bound live sessions per account; retain the newest 19 before adding another.
        db.execute('DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT 19)', (user_id,user_id))
        db.execute('INSERT INTO sessions VALUES(?,?,?,?)', (digest(token), user_id, csrf, self.clock()+SESSION_TTL))
        return {'user': {'id': user_id, 'email': email}, 'csrfToken': csrf}, token

    def register(self, data, ip):
        email = normalize_email(data.get('email'))
        self.throttle('register', ip, email)
        password = check_password(data.get('password'))
        names = [data.get('firstName',''), data.get('lastName','')]
        if any(not isinstance(n,str) or len(n)>100 for n in names) or not names[0].strip():
            raise AuthError('Informe nome e sobrenome válidos.')
        importing = data.get('importLegacy', False)
        if type(importing) is not bool:
            raise AuthError('Opção de importação inválida.')
        if importing and not self.local_mode:
            raise AuthError('Importação do planejamento local indisponível neste servidor.', 403)
        salt, uid = secrets.token_hex(16), secrets.token_urlsafe(18)
        hashed = password_hash(password, salt)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT 1 FROM users WHERE email=?',(email,)).fetchone():
                raise AuthError('Não foi possível criar a conta com este e-mail. Tente entrar ou recuperar o acesso.',409)
            if importing and db.execute('SELECT COUNT(*) FROM users').fetchone()[0] != 0:
                raise AuthError('O planejamento local já foi atribuído ou a primeira conta já foi criada.',409)
            state = json.loads(db.execute('SELECT document FROM app_state WHERE id=1').fetchone()[0]) if importing else self.empty_state()
            state['revision'] = 0
            state['profile'] = {'firstName': names[0].strip(), 'lastName': names[1].strip()}
            db.execute('INSERT INTO users VALUES(?,?,?,?,?)',(uid,email,salt,hashed,self.clock()))
            db.execute('INSERT INTO user_state VALUES(?,?,?)',(uid,0,json.dumps(state,ensure_ascii=False)))
            return self._new_session(db,uid,email)

    def login(self, data, ip):
        supplied = data.get('email')
        # Invalid account identifiers get the same response as incorrect credentials.
        email = supplied.strip().casefold()[:254] if isinstance(supplied,str) else ''
        self.throttle('login',ip,email)
        password = data.get('password')
        with self.store.connect() as db:
            row = db.execute('SELECT id,salt,password_hash FROM users WHERE email=?',(email,)).fetchone()
        bounded = password if isinstance(password,str) and len(password)<=128 else ''
        hashed = password_hash(bounded,row[1] if row else self.dummy_salt)
        if not row or not hmac.compare_digest(hashed,row[2]) or not bounded:
            raise AuthError('E-mail ou senha incorretos.',401)
        with self.store.connect() as db:
            # Prevent issuing a session for a password changed during scrypt verification.
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('SELECT 1 FROM users WHERE id=? AND password_hash=?',(row[0],row[2])).fetchone():
                raise AuthError('E-mail ou senha incorretos.',401)
            return self._new_session(db,row[0],email)

    def logout(self, session):
        with self.store.connect() as db:
            db.execute('DELETE FROM sessions WHERE token_hash=?',(session['tokenHash'],))

    def change_password(self, session, data, ip):
        uid, email = session['user']['id'], session['user']['email']
        self.throttle('password',ip,email)
        password = check_password(data.get('newPassword'))
        current = data.get('currentPassword')
        if not isinstance(current,str) or len(current)>128:
            raise AuthError('Senha atual incorreta.',401)
        with self.store.connect() as db:
            row=db.execute('SELECT salt,password_hash FROM users WHERE id=?',(uid,)).fetchone()
        if not row or not hmac.compare_digest(password_hash(current,row[0]),row[1]):
            raise AuthError('Senha atual incorreta.',401)
        salt=secrets.token_hex(16)
        hashed=password_hash(password,salt)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('SELECT 1 FROM users WHERE id=? AND password_hash=?',(uid,row[1])).fetchone():
                raise AuthError('A senha foi alterada em outra sessão. Entre novamente.',401)
            db.execute('UPDATE users SET salt=?,password_hash=? WHERE id=?',(salt,hashed,uid))
            db.execute('DELETE FROM sessions WHERE user_id=?',(uid,))
            db.execute('DELETE FROM password_resets WHERE user_id=?',(uid,))
            return self._new_session(db,uid,email)

    def forgot(self, data, ip, origin):
        email=normalize_email(data.get('email'))
        self.throttle('forgot',ip,email)
        if not self.password_reset_available:
            raise AuthError('Recuperação por e-mail indisponível. O administrador precisa configurar o envio SMTP.',503)
        token=secrets.token_urlsafe(32)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT id FROM users WHERE email=?',(email,)).fetchone()
            db.execute('DELETE FROM password_resets WHERE expires_at<=?',(self.clock(),))
            if row:
                db.execute('DELETE FROM password_resets WHERE user_id=?',(row[0],))
                db.execute('INSERT INTO password_resets VALUES(?,?,?)',(digest(token),row[0],self.clock()+RESET_TTL))
        if row:
            # Fragment keeps the token out of HTTP request paths, referrers and access logs.
            link=origin+'/redefinir-senha#'+urlencode({'token':token})
            try:
                self.mailer(email,link)
            except Exception:
                with self.store.connect() as db:
                    db.execute('DELETE FROM password_resets WHERE token_hash=?',(digest(token),))
                raise AuthError('O envio de recuperação está indisponível. Tente novamente mais tarde.',503) from None
        return {'ok':True,'message':'Se existir uma conta com este e-mail, enviaremos as instruções de recuperação.'}

    def reset(self,data,ip):
        self.throttle('reset',ip)
        token=data.get('token')
        password=check_password(data.get('password'))
        if not isinstance(token,str) or not 20<=len(token)<=200:
            raise AuthError('Link inválido ou expirado.')
        token_hash=digest(token)
        salt=secrets.token_hex(16)
        hashed=password_hash(password,salt)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT user_id FROM password_resets WHERE token_hash=? AND expires_at>?',(token_hash,self.clock())).fetchone()
            if not row:
                raise AuthError('Link inválido ou expirado.')
            uid=row[0]
            db.execute('UPDATE users SET salt=?,password_hash=? WHERE id=?',(salt,hashed,uid))
            db.execute('DELETE FROM password_resets WHERE user_id=?',(uid,))
            db.execute('DELETE FROM sessions WHERE user_id=?',(uid,))
        return {'ok':True}

    def send_mail(self,email,link):
        message=EmailMessage()
        message['From']=self.env['BRENO_SMTP_FROM']
        message['To']=email
        message['Subject']='Redefina sua senha — Meu Financeiro'
        message.set_content('Você solicitou a redefinição da sua senha. Este link vale por 30 minutos e pode ser usado uma vez:\n\n'+link+'\n\nSe não fez esta solicitação, ignore esta mensagem.')
        mode=self.env.get('BRENO_SMTP_TLS','starttls')
        if mode not in ('starttls','ssl'):
            raise RuntimeError('SMTP requires TLS')
        port=int(self.env.get('BRENO_SMTP_PORT','465' if mode=='ssl' else '587'))
        context=ssl.create_default_context()
        client=smtplib.SMTP_SSL(self.env['BRENO_SMTP_HOST'],port,timeout=15,context=context) if mode=='ssl' else smtplib.SMTP(self.env['BRENO_SMTP_HOST'],port,timeout=15)
        with client:
            if mode=='starttls':
                client.ehlo(); client.starttls(context=context); client.ehlo()
            if self.env.get('BRENO_SMTP_USER'):
                client.login(self.env['BRENO_SMTP_USER'],self.env.get('BRENO_SMTP_PASSWORD',''))
            client.send_message(message)
