#!/usr/bin/env python3
"""Write the real context window of every model the medical agent can reach.

No predefined numbers live here: every value comes from the provider's own
live model list (context_length / context_window), fetched on each run.

- kilo/<id>       : Kilo gateway model list (context_length, top_provider)
- kilo/free-pool  : the routing rule picks one pool target at random, so the
                    usable window is the SMALLEST window among the targets
- ovh/<id>        : OVH AI Endpoints /v1/models (context_length)
- llm7/<id>       : LLM7 /v1/models (context_window.tokens)
- models with no metadata anywhere are listed under "unknown".

LibreChat reads the file (MODEL_CONTEXT_FILE) on each request, cached by
mtime, so a new run takes effect without a restart.
Output: ~/kilo-router/context/model_context.json (written atomically).
"""
import json, os, sys, datetime, urllib.request

HOME = os.path.expanduser('~')
BASE = os.environ.get('BIFROST_URL', 'http://localhost:4120')
OUT_DIR = os.path.join(HOME, 'kilo-router', 'context')
OUT = os.path.join(OUT_DIR, 'model_context.json')
RULE_NAME = 'kilo-free-pool'
ALIAS = 'kilo/free-pool'
KILO_LISTS = ['https://api.kilo.ai/api/gateway/models',
              'https://api.kilocode.ai/api/gateway/models']
OTHER_LISTS = {
    'ovh': 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models',
    'llm7': 'https://api.llm7.io/v1/models',
    'pollinations': 'https://text.pollinations.ai/openai/models',
}


def get(url, headers=None, timeout=40):
    req = urllib.request.Request(url, headers={'user-agent': 'model-context/1.0', **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def as_int(v):
    try:
        v = int(v)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def ctx_of(m):
    """Context window and max output from one model-list entry, provider-agnostic."""
    top = m.get('top_provider') or {}
    cw = m.get('context_window')
    if isinstance(cw, dict):
        cw = cw.get('tokens')
    ctx = (as_int(top.get('context_length')) or as_int(m.get('context_length'))
           or as_int(cw) or as_int(m.get('max_input_tokens')) or as_int(m.get('max_context_length')))
    out = (as_int(top.get('max_completion_tokens')) or as_int(m.get('max_completion_tokens'))
           or as_int(m.get('max_output_tokens')))
    return ctx, out


def entries(js):
    d = js.get('data', js) if isinstance(js, dict) else js
    return [m for m in (d or []) if isinstance(m, dict)]


def main():
    models, unknown, errors = {}, [], []

    kilo = None
    for url in KILO_LISTS:
        try:
            kilo = entries(get(url))
            kilo_src = url
            break
        except Exception as e:
            errors.append('%s: %s' % (url, e))
    if kilo:
        for m in kilo:
            ctx, out = ctx_of(m)
            if ctx:
                models['kilo/' + m['id']] = {'context_length': ctx, 'max_completion_tokens': out, 'source': kilo_src}

    for prov, url in OTHER_LISTS.items():
        try:
            for m in entries(get(url)):
                mid = m.get('id') or m.get('name')
                if not mid:
                    continue
                ctx, out = ctx_of(m)
                if ctx:
                    models['%s/%s' % (prov, mid)] = {'context_length': ctx, 'max_completion_tokens': out, 'source': url}
        except Exception as e:
            errors.append('%s: %s' % (url, e))

    # kilo/free-pool = smallest real window among the routing rule's targets
    token = open(os.path.join(HOME, 'bifrost-data', 'setup_token.txt')).read().strip()
    rules = get(BASE + '/api/routing/rules', {'X-Bifrost-Setup-Token': token}).get('rules', [])
    rule = next((r for r in rules if r.get('name') == RULE_NAME), None)
    if rule:
        targets = ['%s/%s' % (t['provider'], t['model']) for t in rule.get('targets', [])]
        known = {t: models[t] for t in targets if t in models}
        missing = [t for t in targets if t not in models]
        unknown += missing
        if known:
            low = min(known, key=lambda t: known[t]['context_length'])
            outs = [v['max_completion_tokens'] for v in known.values() if v['max_completion_tokens']]
            models[ALIAS] = {
                'context_length': known[low]['context_length'],
                'max_completion_tokens': min(outs) if outs else None,
                'source': 'smallest live context_length among the %d routing targets (%s)' % (len(known), low),
                'targets': {t: known[t]['context_length'] for t in sorted(known)},
                'targets_without_metadata': missing,
                'fallbacks': {f: (models.get(f) or {}).get('context_length') for f in rule.get('fallbacks', [])},
            }
        unknown += [f for f in rule.get('fallbacks', []) if f not in models]

    doc = {'generated_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
           'models': models, 'unknown': sorted(set(unknown)), 'errors': errors}
    if not models:
        print('No model metadata fetched; keeping the previous file.', errors, file=sys.stderr)
        return 1
    os.makedirs(OUT_DIR, exist_ok=True)
    tmp = OUT + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(doc, f, indent=1, sort_keys=True)
    os.replace(tmp, OUT)
    pool = models.get(ALIAS, {})
    print('wrote %s: %d models, %s=%s, unknown=%s' % (OUT, len(models), ALIAS, pool.get('context_length'), doc['unknown']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
