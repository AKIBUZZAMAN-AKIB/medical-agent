#!/usr/bin/env python3
"""Daily Kilo free-model sync for Bifrost.

1. Fetch Kilo's live model list and pick every free model (isFree).
2. Refresh Bifrost's kilo model catalog and set the `medical-agent-free`
   virtual key's kilo allowed_models to exactly today's free list
   (new free models added, removed ones dropped).
3. Test every free model through Bifrost: a plain chat test, then a
   tool-call round trip (model calls the tool, gets the result, answers).
4. Point the routing rule `kilo-free-pool` at every model that passed, with
   equal weights (kilo-auto/free is just one of them), plus fallbacks.
   Callers use the model name `kilo/free-pool`.
5. Write status.json / status.md. Exit code 0 = ok, 1 = failed.

Nothing here prints the virtual key or the setup token.
If the fetch fails or no model passes, the routing rule is left as it was
(last known good) and the run is marked failed.
"""
import json, os, re, sys, time, random, datetime, traceback, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser('~')
BASE = os.environ.get('BIFROST_URL', 'http://localhost:4120')
DATA = os.path.join(HOME, 'bifrost-data')
DIR = os.path.join(HOME, 'kilo-router')
LOGDIR = os.path.join(DIR, 'logs')
VK_NAME = 'medical-agent-free'
RULE_NAME = 'kilo-free-pool'
ALIAS = 'free-pool'            # callers send model "kilo/free-pool"
RULE_PRIORITY = 10
TTFT_MS = 60000                # streaming: move to next fallback if no first token in 60 s
MAX_KILO_FALLBACKS = 3         # fastest passing kilo models used as fallbacks
# Non-Kilo backups tried after the Kilo fallbacks (tool calling passed on 2026-10-28)
EXTRA_FALLBACKS = ['ovh/gpt-oss-120b', 'llm7/gpt-oss:20b', 'pollinations/openai-fast']
KILO_LISTS = ['https://api.kilo.ai/api/gateway/models',
              'https://api.kilocode.ai/api/gateway/models']
REQ_TIMEOUT = 90
CONCURRENCY = 2                # the kilo provider in Bifrost allows 2 at once
MIN_THINKING_POOL = 3          # prefer readable thinking, if at least this many quality-passing models have it
# Quality filter (added 2026-10-28): the medical agent needs good Bangla, correct
# home care and real Banglish understanding. Every tool-passing model also runs
# quality_bench.py (Bangla medical answer + tool round trip); only models that
# pass it join the pool. Results are cached in quality.json for QUALITY_TTL_DAYS.
QUALITY_TTL_DAYS = 3
MIN_QUALITY_POOL = 2           # below this, fall back to the best-scoring tool-passing models
# Never in the pool: routers that pick a random (often tiny) model per call, and
# small models that gave wrong drug names, unsafe advice or loops in the chat.
DENY_PATTERNS = [r'^kilo-auto/', r'^openrouter/free$', r'nano', r'-xs-', r'lightning',
                 r'-a3b', r'-a4b', r'\b[1-9](\.\d+)?b\b', r'mini']

os.makedirs(LOGDIR, exist_ok=True)
RUN_TS = datetime.datetime.now(datetime.timezone.utc)
LOGFILE = os.path.join(LOGDIR, 'run-%s.log' % RUN_TS.strftime('%Y%m%d-%H%M%S'))


def log(msg):
    line = '%s %s' % (datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%S'), msg)
    print(line, flush=True)
    with open(LOGFILE, 'a') as f:
        f.write(line + '\n')


def read_secret(name):
    with open(os.path.join(DATA, name)) as f:
        return f.read().strip()


TOKEN = read_secret('setup_token.txt')
VK = read_secret('virtual_key.txt')


def http(method, url, body=None, headers=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('content-type', 'application/json')
    req.add_header('user-agent', 'kilo-free-sync/1.0')
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            code = r.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        code = e.code
    dt = time.time() - t0
    try:
        js = json.loads(raw) if raw else {}
    except Exception:
        js = {'_raw': raw[:300].decode('utf-8', 'replace')}
    return code, js, dt


def admin(method, path, body=None):
    return http(method, BASE + path, body, {'X-Bifrost-Setup-Token': TOKEN})


def chat(model, payload):
    body = dict(payload)
    body['model'] = 'kilo/' + model
    return http('POST', BASE + '/v1/chat/completions', body, {'x-bf-vk': VK}, timeout=REQ_TIMEOUT)


def err_text(code, js):
    e = js.get('error') if isinstance(js, dict) else None
    if isinstance(e, dict):
        e = e.get('message')
    return ('HTTP %s: %s' % (code, e or js))[:200]


# ---------------------------------------------------------------- steps

def fetch_kilo_free():
    last = None
    for url in KILO_LISTS:
        try:
            code, js, _ = http('GET', url, timeout=40)
            data = js.get('data') or []
            if code == 200 and data:
                free = [m for m in data if m.get('isFree')]
                log('Kilo list from %s: %d models, %d free' % (url, len(data), len(free)))
                return free
            last = 'HTTP %s, %d models' % (code, len(data))
        except Exception as e:
            last = repr(e)
        log('Kilo list failed at %s: %s' % (url, last))
    raise RuntimeError('Could not fetch the Kilo model list (%s)' % last)


def find_vk():
    code, js, _ = admin('GET', '/api/governance/virtual-keys')
    if code != 200:
        raise RuntimeError('Bifrost admin API not reachable: ' + err_text(code, js))
    for v in js.get('virtual_keys', []):
        if v.get('name') == VK_NAME:
            return v
    raise RuntimeError('Virtual key %s not found in Bifrost' % VK_NAME)


def set_kilo_allowed(vk, models):
    pcs = []
    found = False
    for pc in vk['provider_configs']:
        e = {'id': pc['id'], 'provider': pc['provider'], 'weight': pc.get('weight'),
             'allowed_models': pc.get('allowed_models') or [],
             'blacklisted_models': pc.get('blacklisted_models') or []}
        if pc['provider'] == 'kilo':
            found = True
            old = set(e['allowed_models'])
            e['allowed_models'] = models
            added, dropped = sorted(set(models) - old), sorted(old - set(models))
        pcs.append(e)
    if not found:
        pcs.append({'provider': 'kilo', 'weight': 1, 'allowed_models': models, 'blacklisted_models': []})
        added, dropped = models, []
    code, js, _ = admin('PUT', '/api/governance/virtual-keys/%s' % vk['id'], {'provider_configs': pcs})
    if code != 200:
        raise RuntimeError('Updating the virtual key failed: ' + err_text(code, js))
    return added, dropped


TOOLS = [{
    'type': 'function',
    'function': {
        'name': 'get_drug_info',
        'description': 'Look up public label information for a medicine by its generic name.',
        'parameters': {'type': 'object',
                       'properties': {'name': {'type': 'string', 'description': 'Generic medicine name'}},
                       'required': ['name']},
    },
}]


def msg_of(js):
    try:
        return js['choices'][0]['message'] or {}
    except Exception:
        return {}


def has_visible_reasoning(msg):
    # Readable thinking comes back as a `reasoning` / `reasoning_content` string.
    return any(isinstance(msg.get(k), str) and msg.get(k).strip() for k in ('reasoning', 'reasoning_content'))


def encrypted_reasoning_only(msg):
    # Some models only send `reasoning_details` of type reasoning.encrypted: the chat can
    # never show their thinking. (A model that simply did not think on this call is not this.)
    det = msg.get('reasoning_details') or []
    return (not has_visible_reasoning(msg) and isinstance(det, list) and bool(det)
            and all(isinstance(d, dict) and d.get('type') == 'reasoning.encrypted' for d in det))


def with_retry(fn, tries=2):
    out = None
    for i in range(tries):
        out = fn()
        code = out[0]
        if code == 200 or code in (400, 401, 403, 404):
            return out
        time.sleep(8 + 4 * i)
    return out


def test_model(model):
    # Two calls per model (Kilo allows anonymous IPs about 200 free requests an hour):
    # 1) the model must call the tool, 2) given the result it must answer in text (the chat test).
    r = {'model': model, 'chat': False, 'tools': False, 'latency_s': None, 'reason': '', 'rate_limited': False}
    try:
        # 1) tool call
        msgs = [{'role': 'system', 'content': 'You are a medical information assistant. Use tools when they help.'},
                {'role': 'user', 'content': 'Use the get_drug_info tool to look up paracetamol, then tell me its usual adult use in one sentence.'}]
        code, js, dt1 = with_retry(lambda: chat(model, {'messages': msgs, 'tools': TOOLS,
                                                        'tool_choice': 'auto', 'max_tokens': 800}))
        m = msg_of(js)
        calls = m.get('tool_calls') or []
        r['visible_reasoning'] = has_visible_reasoning(m)
        r['encrypted_reasoning'] = encrypted_reasoning_only(m)
        if code != 200 or not calls:
            r['rate_limited'] = code == 429
            r['reason'] = 'tool: ' + (err_text(code, js) if code != 200 else 'no tool call')
            return r
        c = calls[0]
        fn = c.get('function') or {}
        try:
            args = json.loads(fn.get('arguments') or '{}')
        except Exception:
            args = None
        if fn.get('name') != 'get_drug_info' or not isinstance(args, dict) or not args.get('name'):
            r['reason'] = 'tool: bad call %s %s' % (fn.get('name'), str(fn.get('arguments'))[:80])
            return r
        # 3) give the tool result back, expect a final answer
        msgs2 = msgs + [
            {'role': 'assistant', 'content': m.get('content') or '', 'tool_calls': [
                {'id': c.get('id') or 'call_1', 'type': 'function',
                 'function': {'name': 'get_drug_info', 'arguments': fn.get('arguments') or '{}'}}]},
            {'role': 'tool', 'tool_call_id': c.get('id') or 'call_1',
             'content': json.dumps({'name': 'paracetamol', 'use': 'pain relief and fever reduction',
                                    'source': 'test fixture'})}]
        code, js, dt2 = with_retry(lambda: chat(model, {'messages': msgs2, 'tools': TOOLS, 'max_tokens': 800}))
        final = (msg_of(js).get('content') or '').strip()
        m2 = msg_of(js)
        r['visible_reasoning'] = r['visible_reasoning'] or has_visible_reasoning(m2)
        r['encrypted_reasoning'] = (r['encrypted_reasoning'] or encrypted_reasoning_only(m2)) and not r['visible_reasoning']
        if code != 200 or not final:
            r['rate_limited'] = code == 429
            r['reason'] = 'tool result: ' + (err_text(code, js) if code != 200 else 'empty answer')
            return r
        r['chat'] = True
        r['tools'] = True
        r['latency_s'] = round(dt1 + dt2, 1)
    except Exception as e:
        r['reason'] = 'error: %r' % e
    return r


def denied(model):
    return any(re.search(p, model, re.I) for p in DENY_PATTERNS)


def quality_filter(pool, st):
    """Keep only models that pass the Bangla medical quality benchmark."""
    import quality_bench
    qpath = os.path.join(DIR, 'quality.json')
    try:
        with open(qpath) as f:
            cache = json.load(f)
    except Exception:
        cache = {}
    now = RUN_TS.timestamp()
    denied_models = sorted(p['model'] for p in pool if denied(p['model']))
    for m in denied_models:
        log('POOL-SKIP %s (deny list: random router or small model)' % m)
    cand = [p for p in pool if not denied(p['model'])]
    todo = [p['model'] for p in cand
            if p['model'] not in cache or now - cache[p['model']].get('at', 0) > QUALITY_TTL_DAYS * 86400]
    if todo:
        with ThreadPoolExecutor(CONCURRENCY) as ex:
            for r in ex.map(quality_bench.bench, todo):
                if r['quality_rate_limited']:
                    if r['model'] in cache:
                        log('QUALITY %s rate limited, keeping the result from %s' % (
                            r['model'], datetime.datetime.fromtimestamp(cache[r['model']]['at']).date()))
                    else:
                        log('QUALITY %s rate limited, not measured (retried next run)' % r['model'])
                    continue
                r = {k: v for k, v in r.items() if k != 'quality_cases'} | {
                    'at': now, 'cases': [{k: c.get(k) for k in ('case', 'score', 'hard_fail', 'query', 'bangla_ratio', 'latency_s')}
                                         for c in r['quality_cases']]}
                cache[r['model']] = r
                log('QUALITY %s score %s pass %s %s' % (r['model'], r['quality_score'], r['quality_pass'], r['quality_fail']))
    with open(qpath + '.tmp', 'w') as f:
        json.dump(cache, f, indent=1, ensure_ascii=False)
    os.replace(qpath + '.tmp', qpath)
    good = [p for p in cand if cache.get(p['model'], {}).get('quality_pass')]
    st['quality'] = {p['model']: cache.get(p['model'], {}).get('quality_score') for p in pool}
    st['left_out_quality'] = sorted(set(p['model'] for p in pool) - set(p['model'] for p in good))
    lpath = os.path.join(DIR, 'last_good_pool.json')
    if good:
        with open(lpath, 'w') as f:
            json.dump(sorted(p['model'] for p in good), f)
    if len(good) < MIN_QUALITY_POOL:
        # Not enough measured winners (often a rate limit): add back the last pool
        # that passed, as long as those models still pass the tool test today.
        try:
            with open(lpath) as f:
                last = set(json.load(f))
        except Exception:
            last = set()
        extra = [p for p in cand if p['model'] in last and p not in good
                 and not (cache.get(p['model'], {}).get('quality_fail'))]
        good = good + extra
        if len(good) < 1:
            ranked = sorted(cand, key=lambda p: -(cache.get(p['model'], {}).get('quality_score') or 0))
            good = ranked[:MIN_QUALITY_POOL] or pool
            log('QUALITY nothing passed; using the best-scoring %s' % [p['model'] for p in good])
        else:
            log('QUALITY pool %s (passed + last good pool)' % [p['model'] for p in good])
    return good


def find_rule():
    code, js, _ = admin('GET', '/api/routing/rules')
    if code != 200:
        raise RuntimeError('Listing routing rules failed: ' + err_text(code, js))
    for rule in js.get('rules', []):
        if rule.get('name') == RULE_NAME:
            return rule
    return None


def weights(n):
    w = [round(1.0 / n, 6)] * n
    w[-1] = round(1.0 - sum(w[:-1]), 6)
    return w


def upsert_rule(vk_id, passing):
    order = sorted(passing, key=lambda r: r['latency_s'] or 999)
    targets = [{'provider': 'kilo', 'model': r['model'], 'weight': w}
               for r, w in zip(sorted(passing, key=lambda r: r['model']), weights(len(passing)))]
    fallbacks = ['kilo/' + r['model'] for r in order[:MAX_KILO_FALLBACKS]] + EXTRA_FALLBACKS
    body = {'name': RULE_NAME,
            'description': 'Spread kilo/%s across every Kilo free model that passed the daily chat + tool test. '
                           'Managed by ~/kilo-router/kilo_free_sync.py, do not edit by hand.' % ALIAS,
            'enabled': True,
            'cel_expression': "model == '%s'" % ALIAS,
            'targets': targets, 'fallbacks': fallbacks,
            'ttft_timeout_ms': TTFT_MS,
            'scope': 'virtual_key', 'scope_id': vk_id,
            'priority': RULE_PRIORITY, 'chain_rule': False}
    old = find_rule()
    if old:
        code, js, _ = admin('PUT', '/api/routing/rules/%s' % old['id'], body)
    else:
        code, js, _ = admin('POST', '/api/routing/rules', body)
    if code not in (200, 201):
        raise RuntimeError('Saving the routing rule failed: ' + err_text(code, js))
    return (js.get('rule') or {}).get('id') or (old or {}).get('id'), targets, fallbacks


def smoke_alias():
    code, js, dt = http('POST', BASE + '/v1/chat/completions', {
        'model': 'kilo/' + ALIAS, 'max_tokens': 300,
        'messages': [{'role': 'user', 'content': 'Reply with exactly one word: PONG'}]},
        {'x-bf-vk': VK}, timeout=REQ_TIMEOUT)
    return code == 200, (js.get('model') if code == 200 else err_text(code, js))


def write_status(st):
    tmp = os.path.join(DIR, 'status.json.tmp')
    with open(tmp, 'w') as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, os.path.join(DIR, 'status.json'))
    dhaka = RUN_TS + datetime.timedelta(hours=6)
    lines = ['# Kilo free pool - last run', '',
             '- Run: %s Bangladesh time' % dhaka.strftime('%Y-%m-%d %H:%M'),
             '- Result: %s' % ('OK' if st['ok'] else 'FAILED'),
             '- Model name for callers: kilo/%s' % ALIAS]
    if st.get('error'):
        lines.append('- Error: %s' % st['error'])
    lines += ['- Live free on Kilo: %d' % len(st.get('live_free', [])),
              '- Passing: %d, in rotation: %d' % (len(st.get('passing', [])), len(st.get('targets', []))), '']
    for p in st.get('passing', []):
        lines.append('  - %s %s (tool round trip %.1fs)' % ('KEPT' if p.get('kept_after_rate_limit') else 'PASS', p['model'], p['latency_s'] or 0))
    for m, why in sorted(st.get('failing', {}).items()):
        lines.append('  - FAIL %s: %s' % (m, why))
    for m in st.get('left_out_quality', []):
        lines.append('  - LEFT OUT %s: quality score %s (Bangla medical test) or deny list' % (m, (st.get('quality') or {}).get(m)))
    for m in st.get('left_out_no_thinking', []):
        lines.append('  - LEFT OUT %s: passed, but its thinking is encrypted, so the chat cannot show it' % m)
    if st.get('fallbacks'):
        lines += ['', '- Fallbacks: ' + ', '.join(st['fallbacks'])]
    with open(os.path.join(DIR, 'status.md'), 'w') as f:
        f.write('\n'.join(lines) + '\n')


def main():
    st = {'run_at_utc': RUN_TS.isoformat(), 'ok': False, 'alias': 'kilo/' + ALIAS, 'log': LOGFILE}
    try:
        vk = find_vk()
        free = fetch_kilo_free()
        if not free:
            raise RuntimeError('Kilo returned no free models')
        ids = sorted({m['id'] for m in free})
        st['live_free'] = ids
        code, js, _ = admin('POST', '/api/providers/kilo/refresh-models')
        log('refresh-models kilo: HTTP %s' % code)
        added, dropped = set_kilo_allowed(vk, ids)
        st['added'], st['dropped'] = added, dropped
        log('Virtual key kilo models set to %d (added %s, dropped %s)' % (len(ids), added, dropped))

        no_tools = [m['id'] for m in free if 'tools' not in (m.get('supported_parameters') or ['tools'])]
        to_test = [i for i in ids if i not in no_tools]
        failing = {m: 'Kilo lists no tool support' for m in no_tools}
        random.shuffle(to_test)
        with ThreadPoolExecutor(CONCURRENCY) as ex:
            results = list(ex.map(test_model, to_test))
        # A model that only hit Kilo's rate limit is not broken: keep it if it passed last time.
        prev = {}
        try:
            with open(os.path.join(DIR, 'status.json')) as f:
                prev = {p['model']: p for p in json.load(f).get('passing', [])}
        except Exception:
            pass
        passing, kept = [], []
        for r in results:
            if r['tools']:
                passing.append(r)
                log('PASS %s (%ss)' % (r['model'], r['latency_s']))
            elif r['rate_limited'] and r['model'] in prev:
                p = dict(prev[r['model']])
                p['kept_after_rate_limit'] = True
                passing.append(p)
                kept.append(r['model'])
                log('KEPT %s (rate limited today, passed last run)' % r['model'])
            else:
                failing[r['model']] = r['reason']
                log('FAIL %s: %s' % (r['model'], r['reason']))
        st['kept_after_rate_limit'] = kept
        if results and all(r['rate_limited'] for r in results if not r['tools']) and not any(r['tools'] for r in results):
            st['passing'] = sorted(passing, key=lambda r: r['model'])   # keep the list for the next run
            raise RuntimeError('Kilo rate-limited every test (anonymous free limit per IP); routing rule left unchanged')
        st['passing'] = sorted(passing, key=lambda r: r['model'])
        st['failing'] = failing
        if not passing:
            raise RuntimeError('No Kilo free model passed the chat + tool test; routing rule left unchanged')
        # The chat shows the model's thinking live; prefer models whose thinking is readable.
        # Quality first (Bangla medical benchmark), then prefer models whose thinking
        # is readable, but only if enough of the good ones have it. Answer quality wins.
        good = quality_filter(passing, st)
        thinking = [p for p in good if not p.get('encrypted_reasoning')]
        pool = thinking if len(thinking) >= MIN_THINKING_POOL else good
        st['left_out_no_thinking'] = sorted(p['model'] for p in good if p.get('encrypted_reasoning')) if pool is thinking else []
        for m in st['left_out_no_thinking']:
            log('POOL-SKIP %s (good, but its thinking is encrypted: the chat could show none)' % m)
        rule_id, targets, fallbacks = upsert_rule(vk['id'], pool)
        st['rule_id'], st['targets'], st['fallbacks'] = rule_id, targets, fallbacks
        log('Routing rule %s -> %d targets, fallbacks %s' % (rule_id, len(targets), fallbacks))
        ok, got = smoke_alias()
        st['alias_smoke'] = got
        log('Smoke test kilo/%s: %s %s' % (ALIAS, ok, got))
        if not ok:
            raise RuntimeError('Routing rule saved, but a test call to kilo/%s failed: %s' % (ALIAS, got))
        st['ok'] = True
    except Exception as e:
        st['error'] = str(e)
        log('ERROR ' + str(e))
        log(traceback.format_exc())
    write_status(st)
    # keep 30 days of logs
    for f in sorted(os.listdir(LOGDIR))[:-30]:
        try:
            os.remove(os.path.join(LOGDIR, f))
        except OSError:
            pass
    return 0 if st['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
