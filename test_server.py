"""Armazenamento, fronteiras de validação e HTTP local; sem pacotes externos."""
import copy
import datetime as dt
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from server import ConflictError, LocalServer, Store, ValidationError, seed_state, validate_state, MAX_BODY


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / 'app.sqlite', dt.date(2026, 10, 14))
        self.state = self.store.get()

    def tearDown(self):
        self.temp.cleanup()

    def test_seed_fictional_current_month(self):
        self.assertEqual(self.state['profile']['firstName'], 'Marina')
        self.assertEqual(self.state['movements'][0]['date'], '2026-10-05')
        self.assertEqual(self.state['revision'], 0)
        self.assertTrue(all(x['date'] <= '2026-10-14' for x in self.state['movements'] if x['type'] == 'daily'))
        self.assertEqual(sum(x['amount'] for x in self.state['forecastItems']), 150000)

    def test_save_persists_and_increments_revision(self):
        self.state['profile']['firstName'] = 'Teste'
        result = self.store.put(self.state)
        self.assertEqual(result['revision'], 1)
        self.assertEqual(self.state['revision'], 0)
        reopened = Store(self.store.path)
        self.assertEqual(reopened.get(), result)

    def test_stale_revision_cannot_overwrite(self):
        before = self.store.put(self.state)
        self.state['movements'] = []
        with self.assertRaises(ConflictError) as error:
            self.store.put(self.state)
        self.assertEqual(error.exception.revision, 1)
        self.assertEqual(self.store.get(), before)

    def test_concurrent_updates_only_one_wins(self):
        results = []
        barrier = threading.Barrier(2)
        def save():
            barrier.wait()
            try:
                results.append(self.store.put(copy.deepcopy(self.state))['revision'])
            except ConflictError:
                results.append('conflict')
        workers = [threading.Thread(target=save) for _ in range(2)]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join()
        self.assertCountEqual(results, [1, 'conflict'])

    def assert_invalid(self, mutate):
        before = self.store.get()
        state = copy.deepcopy(self.state)
        mutate(state)
        with self.assertRaises(ValidationError):
            self.store.put(state)
        self.assertEqual(self.store.get(), before)

    def test_reject_invalid_money_and_dates(self):
        for value in (12.5, True, -1, 0, 10**15):
            with self.subTest(value=value):
                self.assert_invalid(lambda s: s['movements'][0].update(amount=value))
        for value in ('2026-02-30', '2026-1-01', 'yesterday', '1800-01-01'):
            with self.subTest(date=value):
                self.assert_invalid(lambda s: s['movements'][0].update(date=value))

    def test_reject_dangling_references(self):
        self.assert_invalid(lambda s: s['movements'][0].update(tagIds=['missing']))
        self.assert_invalid(lambda s: s['movements'][0].update(cardId='missing'))
        self.assert_invalid(lambda s: s['tags'].append(copy.deepcopy(s['tags'][0])))
        self.assert_invalid(lambda s: s['tags'].clear())

    def test_tag_rules_and_limits(self):
        self.assert_invalid(lambda s: s['tags'][0]['rules'].update(cost='false'))
        self.assert_invalid(lambda s: s['preferences'].update(forecastDivisor=0))
        self.assert_invalid(lambda s: s.update(checkins=['2026-10-01', '2026-10-01']))
        self.assert_invalid(lambda s: s['tags'].extend([{**s['tags'][0], 'id': f'tag-{i}'} for i in range(101)]))

    def test_installments_and_exceptions(self):
        self.state['movements'][0].update(repeat='installments', count=3, exceptions={'1': {'amount': 100, 'date': '2026-11-06'}})
        validate_state(self.state)
        self.assert_invalid(lambda s: s['movements'][0].update(count=None))
        self.assert_invalid(lambda s: s['movements'][0].update(exceptions={'3': {'deleted': True}}))
        self.assert_invalid(lambda s: s['movements'][0].update(exceptions={'1': {'tagIds':['missing']}}))

    def test_truncated_series_with_one_occurrence_is_valid(self):
        self.state['movements'][0].update(repeat='monthly', count=1)
        saved = self.store.put(self.state)
        self.assertEqual(saved['movements'][0]['count'], 1)
        self.assertEqual(self.store.get(), saved)

    def test_recurrence_anchor_day_preserves_split_month(self):
        self.state['movements'][0].update(date='2026-02-28', recurrenceAnchorDay=31)
        saved = self.store.put(self.state)
        self.assertEqual(saved['movements'][0]['recurrenceAnchorDay'], 31)
        self.assertEqual(self.store.get(), saved)
        self.state = saved
        for anchor in (0, 32, 1.5, True, '31', None, []):
            with self.subTest(anchor=anchor):
                self.assert_invalid(lambda s: s['movements'][0].update(recurrenceAnchorDay=anchor))

    def test_malformed_enums_raise_validation_error(self):
        self.assert_invalid(lambda s: s['movements'][0].update(type=[]))
        self.assert_invalid(lambda s: s['movements'][0].update(repeat={}))
        self.assert_invalid(lambda s: s['tags'][0].update(color=[]))
        self.assert_invalid(lambda s: s['movements'][0].update(tagIds=[{}]))
        self.assert_invalid(lambda s: s['preferences'].update(collapsed=[[]]))

    def test_suggestion_limit(self):
        self.assert_invalid(lambda s: s['suggestions'].append({'id':'s1','message':'x'*601}))
        state = copy.deepcopy(self.state)
        state['suggestions'].append({'id':'s1','type':'bug','message':'Teste local'})
        validate_state(state)

    def test_february_seed_no_future_daily_spending(self):
        state = seed_state(dt.date(2024, 2, 29))
        self.assertTrue(all(x['date'].startswith('2024-02') for x in state['movements']))


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        try:
            cls.server = LocalServer(('127.0.0.1', 0), Store(Path(cls.temp.name) / 'app.sqlite'))
        except PermissionError:
            cls.temp.cleanup()
            raise unittest.SkipTest('Ambiente não permite sockets locais; testes de persistência e validação permanecem ativos.')
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_port
        cls.account, cls.token = cls.server.auth.register({'email':'http@example.test','password':'Example-password-123','firstName':'HTTP','lastName':'Teste','importLegacy':True},'test')

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        auth_headers={'Cookie':'breno_session='+self.token,'X-CSRF-Token':self.account['csrfToken'],'X-Account-Id':self.account['user']['id']}
        auth_headers.update(headers or {})
        connection.request(method, path, body=body, headers=auth_headers)
        response = connection.getresponse()
        content = response.read()
        result = response.status, dict(response.getheaders()), content
        connection.close()
        return result

    def test_api_round_trip(self):
        code, headers, body = self.request('GET', '/api/state')
        self.assertEqual(code, 200)
        state = json.loads(body)
        state['profile']['firstName'] = 'HTTP'
        body = json.dumps(state)
        code, headers, response = self.request('PUT', '/api/state', body, {'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{self.port}'})
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(response)['revision'], state['revision'] + 1)
        code, _, _ = self.request('PUT', '/api/state', body, {'Content-Type': 'application/json'})
        self.assertEqual(code, 409)
        self.assertIn("frame-ancestors 'none'", headers['Content-Security-Policy'])
        self.assertNotIn('Access-Control-Allow-Origin', headers)

    def test_reject_other_origin_and_host(self):
        code, _, _ = self.request('PUT', '/api/state', '{}', {'Content-Type': 'application/json', 'Origin': 'https://attacker.example'})
        self.assertEqual(code, 403)
        code, _, _ = self.request('GET', '/api/state', headers={'Host': f'attacker.example:{self.port}'})
        self.assertEqual(code, 403)
        code, _, _ = self.request('POST', '/api/state', '{}', {'Origin':'null'})
        self.assertEqual(code, 403)

    def test_movement_detail_refresh_routes(self):
        for path in ('/saldos/movimentacoes/demo-salary:0', '/saldos/movimentacoes/demo-salary%3A12'):
            with self.subTest(path=path):
                code, headers, body = self.request('GET', path)
                self.assertEqual(code, 200)
                self.assertIn('text/html', headers['Content-Type'])
                self.assertIn(b'id="app"', body)
        for path in ('/saldos/movimentacoes/demo:abc', '/saldos/movimentacoes/demo:0:1'):
            code, _, _ = self.request('GET', path)
            self.assertEqual(code, 404)

    def test_private_paths_not_served(self):
        for path in ('/server.py', '/seed.json', '/data/app.sqlite', '/assets/../server.py', '/assets/%2e%2e/server.py', '/invented'):
            with self.subTest(path=path):
                code, _, _ = self.request('GET', path)
                self.assertEqual(code, 404)

    def test_malformed_fields_return_400(self):
        _, _, body = self.request('GET', '/api/state')
        original = json.loads(body)
        mutations = [
            lambda s: s['movements'][0].update(type=[]),
            lambda s: s['movements'][0].update(repeat={}),
            lambda s: s['tags'][0].update(color=[]),
            lambda s: s['preferences'].update(collapsed=[{}]),
        ]
        for mutate in mutations:
            state = copy.deepcopy(original)
            mutate(state)
            code, _, _ = self.request('PUT', '/api/state', json.dumps(state), {'Content-Type':'application/json'})
            self.assertEqual(code, 400)

    def test_reject_invalid_body(self):
        for body in ('{}', '{bad', '{"x":NaN}'):
            code, _, _ = self.request('PUT', '/api/state', body, {'Content-Type':'application/json'})
            self.assertEqual(code, 400)
        code, _, _ = self.request('PUT', '/api/state', '{}', {'Content-Type':'text/plain'})
        self.assertEqual(code, 415)
        code, _, _ = self.request('PUT', '/api/state', headers={'Content-Type':'application/json','Content-Length':str(MAX_BODY+1)})
        self.assertEqual(code, 413)


if __name__ == '__main__':
    unittest.main()
