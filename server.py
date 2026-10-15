#!/usr/bin/env python3
"""Servidor pessoal local: arquivos estáticos + estado versionado em SQLite.

Contas e sessões por cookie. Executar: python3 server.py; para HTTPS use --public-origin.
"""
from __future__ import annotations
import argparse
import copy
from contextlib import contextmanager
import datetime as dt
import json
import mimetypes
import hmac
from http.cookies import SimpleCookie
from auth import Auth, AuthError, COOKIE_NAME, SESSION_TTL
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit, parse_qs

ROOT = Path(__file__).resolve().parent
MAX_BODY = 2 * 1024 * 1024
MAX_MONEY = 9_000_000_000_000
TYPES = {'income', 'expense', 'daily', 'saving', 'card'}
METRICS = {'balance', 'performance', 'saved', 'cost', 'average'}
REPEATS = {'none', 'daily', 'weekly', 'monthly', 'installments'}
COLORS = {'gray', 'blue', 'yellow', 'green', 'red', 'purple', 'pink', 'brown'}
STATE_KEYS = {'version', 'revision', 'profile', 'preferences', 'movements', 'tags', 'cards', 'forecastItems', 'checkins', 'suggestions'}
SPA_ROUTES = {
    '/login', '/cadastro', '/esqueci-senha', '/redefinir-senha',
    '/', '/saldos', '/saldos/horizonte', '/totais', '/totais/performance',
    '/totais/economizado', '/totais/custo-de-vida', '/totais/diario-medio',
    '/tags', '/menu', '/menu/perfil', '/menu/previsao-diario',
    '/menu/cartao-de-credito', '/menu/configuracoes', '/menu/sugestoes',
    '/menu/ajuda', '/menu/termos', '/menu/privacidade', '/indicacoes',
}

class ValidationError(ValueError):
    pass

class ConflictError(Exception):
    def __init__(self, revision):
        self.revision = revision


def require(condition, message):
    if not condition:
        raise ValidationError(message)


def text_field(value, name, max_length=200, allow_empty=False):
    require(isinstance(value, str) and (allow_empty or bool(value.strip())) and len(value) <= max_length,
            f'{name}: texto inválido (máximo {max_length} caracteres).')


def integer(value, name, minimum=0, maximum=MAX_MONEY):
    require(type(value) is int and minimum <= value <= maximum, f'{name}: inteiro fora do limite.')


def date_field(value):
    require(isinstance(value, str) and bool(re.fullmatch(r'\d{4}-\d{2}-\d{2}', value)), 'Data inválida.')
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError as exc:
        raise ValidationError('Data inválida.') from exc
    require(1900 <= parsed.year <= 2200, 'Data deve estar entre 1900 e 2200.')


def items(value, name, limit):
    require(isinstance(value, list) and len(value) <= limit, f'{name}: lista inválida ou limite excedido ({limit}).')
    ids = set()
    for item in value:
        require(isinstance(item, dict), f'{name}: registro inválido.')
        ident = item.get('id')
        text_field(ident, f'{name}.id', 128)
        require(ident not in ids, f'{name}: ID duplicado.')
        ids.add(ident)
    return ids


def movement_fields(item, tag_ids, card_ids, partial=False):
    for field in ('type', 'amount', 'description', 'date', 'tagIds', 'cardId'):
        require(partial or field in item, f'Movimentação sem {field}.')
    if 'type' in item:
        require(isinstance(item['type'], str) and item['type'] in TYPES, 'Categoria inválida.')
    if 'amount' in item:
        integer(item['amount'], 'Valor', 1)
    if 'description' in item:
        text_field(item['description'], 'Descrição', 600, allow_empty=True)
    if 'date' in item:
        date_field(item['date'])
    if 'tagIds' in item:
        tags = item['tagIds']
        require(isinstance(tags, list) and all(isinstance(x, str) for x in tags), 'Tags inválidas.')
        require(len(tags) <= 100 and len(tags) == len(set(tags)) and set(tags) <= tag_ids, 'Referência de tag inválida.')
    if 'cardId' in item:
        require(item['cardId'] is None or isinstance(item['cardId'], str) and item['cardId'] in card_ids, 'Referência de cartão inválida.')
    if 'deleted' in item:
        require(type(item['deleted']) is bool, 'Exclusão de ocorrência inválida.')


def validate_state(state):
    require(isinstance(state, dict) and STATE_KEYS <= state.keys(), 'Estado incompleto.')
    require(type(state['version']) is int and state['version'] == 1, 'Versão não suportada.')
    integer(state['revision'], 'Revisão', 0, 2**53 - 1)
    profile = state['profile']
    require(isinstance(profile, dict), 'Perfil inválido.')
    for name in ('firstName', 'lastName'):
        text_field(profile.get(name), name, 100, allow_empty=True)
    if 'email' in profile:
        text_field(profile['email'], 'E-mail', 254, allow_empty=True)
    prefs = state['preferences']
    require(isinstance(prefs, dict), 'Preferências inválidas.')
    require(prefs.get('theme') in ('dark', 'light', 'system'), 'Tema inválido.')
    require(prefs.get('period') in ('current', 'previous', 'year'), 'Período inválido.')
    integer(prefs.get('forecastDivisor'), 'Divisor', 28, 31)
    collapsed = prefs.get('collapsed')
    require(isinstance(collapsed, list) and all(isinstance(x, str) for x in collapsed), 'Colunas inválidas.')
    require(set(collapsed) <= TYPES and len(set(collapsed)) == len(collapsed), 'Colunas inválidas.')
    tag_ids = items(state['tags'], 'Tags', 100)
    for tag in state['tags']:
        text_field(tag.get('name'), 'Nome da tag', 100)
        require(isinstance(tag.get('color'), str) and (tag['color'] in COLORS or bool(re.fullmatch(r'#[0-9a-fA-F]{6}', tag['color']))), 'Cor inválida.')
        rules = tag.get('rules')
        require(isinstance(rules, dict) and METRICS <= rules.keys() and all(type(rules[k]) is bool for k in METRICS), 'Regras da tag inválidas.')
    card_ids = items(state['cards'], 'Cartões', 100)
    for card in state['cards']:
        text_field(card.get('name'), 'Nome do cartão', 100)
        integer(card.get('closingDay'), 'Fechamento', 1, 31)
        integer(card.get('dueDay'), 'Vencimento', 1, 31)
    items(state['movements'], 'Movimentações', 20000)
    for movement in state['movements']:
        movement_fields(movement, tag_ids, card_ids)
        if 'recurrenceAnchorDay' in movement:
            integer(movement['recurrenceAnchorDay'], 'Dia âncora da repetição', 1, 31)
        repeat = movement.get('repeat')
        require(isinstance(repeat, str) and repeat in REPEATS, 'Repetição inválida.')
        count = movement.get('count')
        require(count is None or type(count) is int and 1 <= count <= 10000, 'Quantidade de repetições inválida.')
        require(repeat != 'installments' or count is not None, 'Parcelamento exige quantidade.')
        exceptions = movement.get('exceptions', {})
        require(isinstance(exceptions, dict) and len(exceptions) <= 10000, 'Exceções inválidas.')
        for index, override in exceptions.items():
            require(isinstance(index, str) and bool(re.fullmatch(r'0|[1-9]\d{0,5}', index)), 'Índice de ocorrência inválido.')
            require(count is None or int(index) < count, 'Exceção fora da série.')
            require(isinstance(override, dict), 'Exceção inválida.')
            movement_fields(override, tag_ids, card_ids, partial=True)
    items(state['forecastItems'], 'Previsões', 500)
    for item in state['forecastItems']:
        text_field(item.get('description'), 'Descrição da previsão', 600)
        integer(item.get('amount'), 'Previsão', 1)
    checkins = state['checkins']
    require(isinstance(checkins, list) and len(checkins) <= 20000, 'Check-ins inválidos.')
    for date in checkins:
        date_field(date)
    require(len(checkins) == len(set(checkins)), 'Check-in duplicado.')
    items(state['suggestions'], 'Sugestões', 1000)
    for suggestion in state['suggestions']:
        text_field(suggestion.get('message', suggestion.get('text')), 'Sugestão', 600)
        kind = suggestion.get('type', suggestion.get('category', 'other'))
        require(kind in ('suggestion', 'improvement', 'bug', 'other', 'sugestao', 'melhoria', 'erro', 'outro'), 'Tipo de sugestão inválido.')
    return state


def seed_state(today=None):
    today = today or dt.date.today()
    template = json.loads((ROOT / 'seed.json').read_text(encoding='utf-8'))
    for movement in template['movements']:
        if movement['date'].startswith('@month:'):
            movement['date'] = today.replace(day=int(movement['date'][7:])).isoformat()
    for day in range(1, today.day + 1):
        if day % 3 == 1:
            template['movements'].append({
                'id': f'demo-daily-{day}', 'type': 'daily', 'amount': 2800 + (day % 5) * 675,
                'description': 'Mercado e alimentação', 'date': today.replace(day=day).isoformat(),
                'tagIds': ['tag-food'], 'cardId': None, 'repeat': 'none', 'count': None, 'exceptions': {},
            })
    template['checkins'] = [today.replace(day=d).isoformat() for d in range(1, today.day)]
    return validate_state(template)


def empty_state():
    return {'version': 1, 'revision': 0, 'profile': {'firstName': '', 'lastName': ''},
            'preferences': {'theme': 'dark', 'collapsed': [], 'period': 'current', 'forecastDivisor': 30},
            'movements': [], 'tags': [], 'cards': [], 'forecastItems': [], 'checkins': [], 'suggestions': []}


class Store:
    def __init__(self, path, today=None):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, document TEXT NOT NULL)')
            db.execute('INSERT OR IGNORE INTO app_state VALUES (1, 0, ?)', (json.dumps(seed_state(today), ensure_ascii=False),))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.execute('PRAGMA busy_timeout=10000')
        db.execute('PRAGMA foreign_keys=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, user_id=None):
        with self.connect() as db:
            row = db.execute('SELECT document FROM app_state WHERE id = 1').fetchone() if user_id is None else db.execute('SELECT document FROM user_state WHERE user_id=?', (user_id,)).fetchone()
        if row is None:
            raise AuthError('Conta indisponível.', 401)
        return json.loads(row[0])

    def put(self, state, user_id=None):
        validate_state(state)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT revision FROM app_state WHERE id = 1').fetchone() if user_id is None else db.execute('SELECT revision FROM user_state WHERE user_id=?', (user_id,)).fetchone()
            if row is None:
                raise AuthError('Conta indisponível.', 401)
            revision = row[0]
            if state['revision'] != revision:
                raise ConflictError(revision)
            updated = copy.deepcopy(state)
            updated['revision'] = revision + 1
            if user_id is None:
                db.execute('UPDATE app_state SET revision = ?, document = ? WHERE id = 1', (updated['revision'], json.dumps(updated, ensure_ascii=False)))
            else:
                db.execute('UPDATE user_state SET revision=?,document=? WHERE user_id=?', (updated['revision'], json.dumps(updated, ensure_ascii=False), user_id))
        return updated


class Handler(BaseHTTPRequestHandler):
    server_version = 'BrenoLocal/1.0'

    def security_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        self.send_header('Cache-Control', 'no-store')

    def reply(self, code, value, headers=None):
        data = json.dumps(value, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.security_headers()
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def request_origin(self):
        return self.server.public_origin or 'http://' + self.headers.get('Host', '')

    def allowed_request(self, mutation=False):
        host = self.headers.get('Host', '')
        try:
            parsed = urlsplit('//' + host)
            port = parsed.port
        except ValueError:
            self.reply(403, {'error': 'Endereço inválido.'})
            return False
        if self.server.public_origin:
            allowed = host == urlsplit(self.server.public_origin).netloc
        else:
            allowed = parsed.hostname in ('localhost', '127.0.0.1') and port == self.server.server_port
        if not allowed or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            self.reply(403, {'error': 'Endereço deste servidor não autorizado.'})
            return False
        origin = self.headers.get('Origin')
        if mutation and origin and origin != self.request_origin():
            self.reply(403, {'error': 'Origem de gravação não autorizada.'})
            return False
        if mutation and self.headers.get('Sec-Fetch-Site') == 'cross-site':
            self.reply(403, {'error': 'Gravação externa não autorizada.'})
            return False
        return True

    def session(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
        except Exception:
            return None
        value = cookie.get(COOKIE_NAME)
        return self.server.auth.session(value.value if value else '')

    def require_session(self, mutation=False, state_request=False):
        session = self.session()
        if not session:
            self.reply(401, {'error': 'Sua sessão terminou. Entre novamente.', 'code':'session_expired'})
            return None
        if state_request:
            expected = self.headers.get('X-Account-Id')
            if expected is not None and expected != session['user']['id']:
                self.reply(409, {'error':'A conta mudou em outra aba. Entre novamente para continuar.', 'code':'account_changed'})
                return None
        if mutation:
            csrf=self.headers.get('X-CSRF-Token','')
            if not hmac.compare_digest(csrf.encode('utf-8'),session['csrfToken'].encode('utf-8')):
                self.reply(403, {'error':'Sessão de segurança desatualizada. Recarregue a página.', 'code':'csrf_invalid'})
                return None
        return session

    def cookie_header(self, token='', clear=False):
        secure='; Secure' if self.server.public_origin else ''
        age=0 if clear else SESSION_TTL
        return {'Set-Cookie':f'{COOKIE_NAME}={token}; Path=/; Max-Age={age}; HttpOnly; SameSite=Lax{secure}'}

    def read_json(self, limit=MAX_BODY):
        if self.headers.get('Transfer-Encoding'):
            raise AuthError('Transfer-Encoding não suportado.',400)
        if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
            raise AuthError('Use application/json.',415)
        length=self.headers.get('Content-Length','')
        if not length.isdigit() or int(length)>limit or int(length)<2:
            raise AuthError('Corpo da requisição inválido ou maior que o limite.',413)
        data=self.rfile.read(int(length))
        require(len(data)==int(length),'Requisição incompleta.')
        result=json.loads(data,parse_constant=lambda _: (_ for _ in ()).throw(ValidationError('Número inválido.')))
        require(isinstance(result,dict),'Objeto JSON esperado.')
        return result

    def do_GET(self):
        if not self.allowed_request():
            return
        path = unquote(urlsplit(self.path).path)
        if path == '/api/auth/session':
            session = self.session()
            result = {'user': session['user'] if session else None, 'legacyAvailable':self.server.auth.legacy_available(), 'passwordResetAvailable':self.server.auth.password_reset_available}
            if session:
                result['csrfToken'] = session['csrfToken']
            return self.reply(200,result)
        if path == '/api/state':
            session=self.require_session(state_request=True)
            if not session:
                return
            state=self.server.store.get(session['user']['id'])
            headers={'X-Account-Id':session['user']['id']}
            since=parse_qs(urlsplit(self.path).query).get('since',[''])[0]
            if since.isdigit() and int(since)==state['revision']:
                self.send_response(304)
                self.security_headers()
                self.send_header('X-Account-Id',session['user']['id'])
                self.end_headers()
                return
            return self.reply(200,state,headers)
        if path.startswith('/api/'):
            if not self.require_session():
                return
            return self.reply(404,{'error':'Operação não encontrada.'})
        if path == '/health':
            return self.reply(200, {'ok': True})
        static = path.lstrip('/')
        if static in ('index.html', 'app.mjs', 'domain.mjs', 'styles.css', 'auth-ui.mjs', 'auth.css', 'sync.mjs'):
            target = ROOT / static
        elif path.startswith('/assets/'):
            target = (ROOT / static).resolve()
            if not target.is_relative_to(ROOT / 'assets') or target.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf'):
                return self.reply(404, {'error': 'Arquivo não encontrado.'})
        elif (path.rstrip('/') or '/') in SPA_ROUTES or re.fullmatch(r'/saldos/movimentacoes/[\w.-]+(?::[0-9]+)?', path) or re.fullmatch(r'/menu/ajuda/[1-6]', path):
            target = ROOT / 'index.html'
        else:
            return self.reply(404, {'error': 'Página não encontrada.'})
        if not target.is_file():
            return self.reply(404, {'error': 'Arquivo não encontrado.'})
        data = target.read_bytes()
        mime = 'text/javascript' if target.suffix == '.mjs' else mimetypes.guess_type(str(target))[0] or 'application/octet-stream'
        self.send_response(200)
        self.security_headers()
        self.send_header('Content-Type', mime + ('; charset=utf-8' if mime.startswith('text/') else ''))
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def do_HEAD(self):
        self.do_GET()

    def do_PUT(self):
        if not self.allowed_request(mutation=True):
            return
        session=self.require_session(mutation=True,state_request=True)
        if not session:
            return
        if urlsplit(self.path).path != '/api/state':
            return self.reply(404, {'error': 'Operação não encontrada.'})
        try:
            state=self.read_json()
            updated=self.server.store.put(state,session['user']['id'])
        except ConflictError as exc:
            return self.reply(409, {'error':'Os dados mudaram em outra aba. Revise antes de salvar.', 'revision':exc.revision})
        except AuthError as exc:
            return self.reply(exc.status, {'error':exc.message})
        except (ValidationError, ValueError, TypeError, KeyError, RecursionError) as exc:
            return self.reply(400, {'error':str(exc) if isinstance(exc, ValidationError) else 'JSON ou campos inválidos.'})
        except sqlite3.Error:
            return self.reply(503, {'error':'Não foi possível gravar os dados. Tente novamente.'})
        return self.reply(200,updated,{'X-Account-Id':session['user']['id']})

    def do_POST(self):
        if not self.allowed_request(mutation=True):
            return
        path=urlsplit(self.path).path
        auth=self.server.auth
        ip=self.client_address[0]
        try:
            if path in ('/api/auth/logout','/api/auth/password'):
                session=self.require_session(mutation=True)
                if not session:
                    return
                if path.endswith('/logout'):
                    auth.logout(session)
                    return self.reply(200,{'ok':True},self.cookie_header(clear=True))
                result,token=auth.change_password(session,self.read_json(16384),ip)
                return self.reply(200,result,self.cookie_header(token))
            if path not in ('/api/auth/login','/api/auth/register','/api/auth/forgot','/api/auth/reset'):
                if not self.require_session(mutation=True):
                    return
                return self.reply(404,{'error':'Operação não encontrada.'})
            data=self.read_json(16384)
            if path.endswith('/login'):
                result,token=auth.login(data,ip)
                return self.reply(200,result,self.cookie_header(token))
            if path.endswith('/register'):
                result,token=auth.register(data,ip)
                return self.reply(201,result,self.cookie_header(token))
            if path.endswith('/forgot'):
                return self.reply(200,auth.forgot(data,ip,self.request_origin()))
            return self.reply(200,auth.reset(data,ip),self.cookie_header(clear=True))
        except AuthError as exc:
            return self.reply(exc.status,{'error':exc.message})
        except (ValidationError,ValueError,TypeError,KeyError,RecursionError):
            return self.reply(400,{'error':'JSON ou campos inválidos.'})
        except sqlite3.Error:
            return self.reply(503,{'error':'Serviço temporariamente indisponível.'})

    def do_DELETE(self):
        if self.allowed_request(mutation=True):
            self.reply(405,{'error':'Método não permitido.'})

    def do_OPTIONS(self):
        self.do_DELETE()

    def log_message(self, format, *args):
        # Never log query strings, reset links, passwords, tokens, or request bodies.
        path=urlsplit(self.path).path
        known=path if path in SPA_ROUTES or path in ('/api/state','/api/auth/session','/api/auth/login','/api/auth/register','/api/auth/logout','/api/auth/password','/api/auth/forgot','/api/auth/reset','/health') else '/[arquivo]'
        super().log_message('%s %s',self.command,known)


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, store, public_origin=None, auth=None):
        if public_origin:
            parsed=urlsplit(public_origin)
            if parsed.scheme!='https' or not parsed.hostname or parsed.path not in ('','/') or parsed.query or parsed.fragment or parsed.username or parsed.password:
                raise ValueError('--public-origin deve ser uma origem HTTPS sem caminho.')
            public_origin=public_origin.rstrip('/')
        self.store, self.public_origin = store, public_origin
        self.auth=auth or Auth(store,empty_state,local_mode=not bool(public_origin))
        super().__init__(address, Handler)

    def get_request(self):
        sock, address = super().get_request()
        sock.settimeout(15)
        return sock, address


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=4173)
    parser.add_argument('--db', type=Path, default=ROOT / 'data' / 'app.sqlite')
    parser.add_argument('--public-origin', help='Origem HTTPS canônica do proxy, ex.: https://financeiro.exemplo.com')
    args = parser.parse_args()
    with LocalServer(('127.0.0.1', args.port), Store(args.db), public_origin=args.public_origin) as server:
        print(f'Sistema local disponível em http://127.0.0.1:{server.server_port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
