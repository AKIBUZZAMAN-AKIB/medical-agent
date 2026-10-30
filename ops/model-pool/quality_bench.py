#!/usr/bin/env python3
"""Bangla medical quality benchmark for Kilo free models (via Bifrost).

Used by kilo_free_sync.py (daily) and runnable on its own:
    python3 quality_bench.py model1 model2 ...

Each model gets two short cases that mirror the medical agent:
  A) Banglish child fever + rash: must call the knowledge tool, then answer in
     Bangla script, say paracetamol is OK, never say "don't give paracetamol",
     warn against ibuprofen/aspirin (dengue), no loop, no leaked <think>.
  B) Banglish "kalajor er lokkhon ki": must understand kala-azar
     (tool call argument or answer mentions kala-azar / leishmaniasis /
     কালাজ্বর) and answer in Bangla.
Score 0-100. A model passes with >= PASS_SCORE and no hard failure.
"""
import json, re, sys, time, os, urllib.request, urllib.error

HOME = os.path.expanduser('~')
BASE = os.environ.get('BIFROST_URL', 'http://localhost:4120')
VK = open(os.path.join(HOME, 'bifrost-data', 'virtual_key.txt')).read().strip()
PASS_SCORE = 70
TIMEOUT = 150

SYSTEM = (
    'You are Super-Power Doctor AI, a medical information assistant for Bangladesh. '
    'Always look things up with the tools before answering. Reply in the user\'s language: '
    'if the user writes Bangla or Banglish (Bangla in Latin letters), reply in Bangla script. '
    'Give practical, structured help with short headings and bullets, cite sources, '
    'and write every number with English digits (500 mg, 16263).')

TOOLS = [{'type': 'function', 'function': {
    'name': 'disease_knowledge_search',
    'description': 'Search the disease knowledge base (symptoms, causes, danger signs, tests, prevention). '
                   'Query in English medical terms.',
    'parameters': {'type': 'object', 'properties': {
        'query': {'type': 'string', 'description': 'English search query, e.g. "dengue fever rash child"'}},
        'required': ['query']}}}]

FEVER_RESULT = {
    'reply_language': 'bn',
    'results': [
        {'id': 'D0051', 'name': 'Dengue fever', 'symptoms': 'high fever, rash, headache, pain behind eyes, joint/muscle pain',
         'danger_signs': 'abdominal pain, persistent vomiting, bleeding gums, lethargy, cold hands',
         'tests': 'NS1 antigen (day 1-5), CBC with platelet count',
         'care': 'Paracetamol for fever (weight-based dose for children). Avoid ibuprofen, aspirin and other NSAIDs. Plenty of fluids.',
         'sources': 'WHO dengue fact sheet; DGHS National Dengue Guideline'},
        {'id': 'D0412', 'name': 'Measles', 'symptoms': 'fever, cough, red eyes, then rash spreading from face',
         'sources': 'WHO measles fact sheet'}]}
KALA_RESULT = {
    'reply_language': 'bn',
    'results': [{'id': 'D0133', 'name': 'Visceral leishmaniasis (kala-azar)',
                 'symptoms': 'long fever (more than 2 weeks), weight loss, enlarged spleen and liver, anaemia, darkened skin',
                 'spread': 'bite of infected sandfly', 'tests': 'rK39 rapid test',
                 'sources': 'WHO leishmaniasis fact sheet; DGHS Kala-azar Elimination Programme'}]}

CASES = [
    {'id': 'child_fever', 'user': 'amar baccar 3 din dhore jor, gaye lal dana. ki korbo?', 'result': FEVER_RESULT},
    {'id': 'kalajor', 'user': 'kalajor er lokkhon ki?', 'result': KALA_RESULT},
]

BN = re.compile(r'[\u0980-\u09FF]')
LATIN = re.compile(r'[A-Za-z]')


def post(model, body):
    body = dict(body, model='kilo/' + model)
    req = urllib.request.Request(BASE + '/v1/chat/completions', data=json.dumps(body).encode(), method='POST')
    req.add_header('content-type', 'application/json')
    req.add_header('x-bf-vk', VK)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            js, code = json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        code = e.code
        try:
            js = json.loads(e.read())
        except Exception:
            js = {}
    return code, js, time.time() - t0


def msg(js):
    try:
        return js['choices'][0]['message'] or {}
    except Exception:
        return {}


def looped(text):
    # same 40-char chunk repeated 4+ times = a loop
    chunks = [text[i:i + 40] for i in range(0, max(0, len(text) - 40), 40)]
    seen = {}
    for c in chunks:
        if len(c.strip()) < 20:
            continue
        seen[c] = seen.get(c, 0) + 1
        if seen[c] >= 4:
            return True
    return False


def run_case(model, case):
    out = {'case': case['id'], 'score': 0, 'hard_fail': '', 'notes': []}
    msgs = [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': case['user']}]
    code, js, dt1 = post(model, {'messages': msgs, 'tools': TOOLS, 'tool_choice': 'auto', 'max_tokens': 1500})
    if code == 429:
        out['rate_limited'] = True
        out['hard_fail'] = 'rate limited'
        return out
    m = msg(js)
    calls = m.get('tool_calls') or []
    if code != 200:
        out['hard_fail'] = 'HTTP %s' % code
        return out
    score = 0
    query = ''
    if calls:
        score += 20
        try:
            query = (json.loads(calls[0]['function'].get('arguments') or '{}').get('query') or '')
        except Exception:
            pass
        c = calls[0]
        msgs2 = msgs + [
            {'role': 'assistant', 'content': m.get('content') or '', 'tool_calls': [
                {'id': c.get('id') or 'call_1', 'type': 'function',
                 'function': {'name': 'disease_knowledge_search', 'arguments': c['function'].get('arguments') or '{}'}}]},
            {'role': 'tool', 'tool_call_id': c.get('id') or 'call_1', 'content': json.dumps(case['result'], ensure_ascii=False)}]
        code, js, dt2 = post(model, {'messages': msgs2, 'tools': TOOLS, 'max_tokens': 2500})
        if code != 200:
            out['hard_fail'] = 'answer HTTP %s' % code
            out['rate_limited'] = code == 429
            return out
        ans = (msg(js).get('content') or '').strip()
    else:
        out['notes'].append('no tool call')
        dt2 = 0
        ans = (m.get('content') or '').strip()
    out['latency_s'] = round(dt1 + dt2, 1)
    out['answer_head'] = ans[:300]
    out['answer_full'] = ans
    out['query'] = query[:120]
    if not ans:
        out['hard_fail'] = 'empty answer'
        return out
    if re.search(r'<think>|</think>|<\|channel\|>|analysis<\|', ans):
        out['hard_fail'] = 'leaked thinking'
    if looped(ans):
        out['hard_fail'] = 'loop'
    # other Indic / CJK scripts or Latin letters glued inside Bangla words = garbled output
    foreign = re.findall(r'[\u0900-\u0963\u0966-\u097F\u0A00-\u0DFF\u4E00-\u9FFF]', ans)
    glued = re.findall(r'[\u0980-\u09FF][a-zA-Z]{1,6}[\u0980-\u09FF]', ans)
    if len(foreign) >= 2 or glued:
        out['hard_fail'] = out['hard_fail'] or 'mixed scripts (%s)' % (''.join(foreign[:6]) or glued[0])
    bn, lat = len(BN.findall(ans)), len(LATIN.findall(ans))
    ratio = bn / max(1, bn + lat)
    out['bangla_ratio'] = round(ratio, 2)
    if ratio >= 0.6:
        score += 25
    elif ratio >= 0.4:
        score += 12
    else:
        out['notes'].append('not in Bangla')
    if 300 <= len(ans) <= 6000:
        score += 10
    if re.search(r'^\s*(#+|\*\*|[-•*]\s|\d+\.)', ans, re.M):
        score += 5
    if case['id'] == 'child_fever':
        para = re.search(r'প্যারাসিটামল|paracetamol|নাপা|acetaminophen', ans, re.I)
        neg = re.search(r'(প্যারাসিটামল|paracetamol)[^।.\n]{0,40}(দেবেন না|খাওয়াবেন না|খাবেন না|দিবেন না|নিষেধ|avoid|do not|don\'t)', ans, re.I)
        if neg and not re.search(r'(আইবুপ্রোফেন|ibuprofen|অ্যাসপিরিন|aspirin|NSAID)[^\n]{0,60}' , neg.group(0), re.I):
            out['hard_fail'] = out['hard_fail'] or 'says no paracetamol'
        if para:
            score += 15
        if re.search(r'আইবুপ্রোফেন|ibuprofen|অ্যাসপিরিন|aspirin|NSAID|এনএসএআইডি', ans, re.I):
            score += 10
        if re.search(r'NS1|CBC|প্লাটিলেট|প্লেটলেট|platelet', ans, re.I):
            score += 10
    else:
        # with a tool call, the search itself must be about kala-azar
        understood = re.search(r'kala.?azar|leishmania|কালাজ্বর|কালা-আজার|কালাজার', query if query else ans, re.I)
        if understood:
            score += 20
        else:
            out['hard_fail'] = out['hard_fail'] or 'did not understand kalajor'
        if re.search(r'বালুমাছি|স্যান্ডফ্লাই|sand ?fly|প্লীহা|প্লিহা|spleen|rK39', ans, re.I):
            score += 20
    out['score'] = max(0, min(100, score))
    return out


JUDGE_MODELS = ['ovh/gpt-oss-120b', 'kilo/nvidia/nemotron-3-ultra-550b-a55b:free']
JUDGE_PROMPT = '''You are a strict reviewer of Bangla (Bengali) medical text written for patients in Bangladesh. Rate the TEXT below.
Score "bangla" 1-5: 5 = natural, correct standard Bangladeshi Bangla; 4 = good with one or two odd words; 3 = understandable but with several wrong or invented words; 1-2 = broken Bangla.
Score "medical" 1-5: 5 = medically correct and safe; 1-2 = a dangerous or clearly wrong statement, or a wrong drug or disease name.
Reply with JSON only: {"bangla": n, "medical": n, "bad_words": ["..."]}

TEXT:
'''


def judge(text):
    """Second model rates Bangla and medical correctness (ratio checks miss invented words)."""
    for jm in JUDGE_MODELS:
        body = {'model': jm, 'max_tokens': 1500, 'temperature': 0,
                'messages': [{'role': 'user', 'content': JUDGE_PROMPT + text[:2500]}]}
        req = urllib.request.Request(BASE + '/v1/chat/completions', data=json.dumps(body).encode(), method='POST')
        req.add_header('content-type', 'application/json')
        req.add_header('x-bf-vk', VK)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                c = json.loads(r.read())['choices'][0]['message'].get('content') or ''
            m = re.search(r'\{.*\}', c, re.S)
            if m:
                js = json.loads(m.group(0))
                return {'bangla': int(js.get('bangla', 0)), 'medical': int(js.get('medical', 0)),
                        'bad_words': (js.get('bad_words') or [])[:6], 'judge': jm}
        except Exception:
            continue
    return None


def bench(model):
    cases = []
    for case in CASES:
        r = run_case(model, case)
        if r['hard_fail'] in ('empty answer', 'answer HTTP 500', 'answer HTTP 502', 'HTTP 502', 'HTTP 500'):
            r = run_case(model, case)  # one retry for a transient empty/5xx reply
        cases.append(r)
    for c in cases:
        if c.get('answer_full') and not c['hard_fail']:
            j = judge(c['answer_full'])
            c['judge'] = j
            if j:
                if j['bangla'] <= 3:
                    c['hard_fail'] = 'weak Bangla (judge %s/5: %s)' % (j['bangla'], ', '.join(map(str, j['bad_words'][:3])))
                elif j['medical'] <= 2:
                    c['hard_fail'] = 'medical error (judge %s/5)' % j['medical']
        c.pop('answer_full', None)
    rl = any(c.get('rate_limited') for c in cases)
    hard = [c['case'] + ': ' + c['hard_fail'] for c in cases if c['hard_fail']]
    score = round(sum(c['score'] for c in cases) / len(cases))
    return {'model': model, 'quality_score': score, 'quality_pass': (not hard) and score >= PASS_SCORE,
            'quality_rate_limited': rl, 'quality_fail': hard, 'quality_cases': cases}


if __name__ == '__main__':
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(2) as ex:
        for r in ex.map(bench, sys.argv[1:]):
            print(json.dumps(r, ensure_ascii=False))
            sys.stdout.flush()
