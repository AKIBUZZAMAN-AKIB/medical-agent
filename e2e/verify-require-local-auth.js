// Verifies requireLocalAuth's status codes with zero npm dependencies:
// `passport` and `@librechat/data-schemas` are injected through Module._load.
const Module = require('node:module');

const origLoad = Module._load;
let nextResult = [null, false, undefined];

Module._load = function (request) {
  if (request === 'passport') {
    return {
      authenticate: (_strategy, cb) => {
        cb(...nextResult);
        return () => {};
      },
    };
  }
  if (request === '@librechat/data-schemas') {
    return { logger: { error() {}, debug() {} } };
  }
  return origLoad.apply(this, arguments);
};

const requireLocalAuth = require('/home/user/medical-agent/api/server/middleware/requireLocalAuth.js');

function run(result) {
  nextResult = result;
  const req = {};
  const res = {
    statusCode: null,
    body: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
  let nextArg = 'NOT CALLED';
  const next = (a) => {
    nextArg = a;
  };
  requireLocalAuth(req, res, next);
  return { status: res.statusCode, body: res.body, next: nextArg, req };
}

const cases = [
  {
    name: 'wrong password -> 401 carrying Passport message',
    r: run([null, false, { message: 'Incorrect password.' }]),
    ok: (x) => x.status === 401 && x.body && x.body.message === 'Incorrect password.',
  },
  {
    name: 'no user, no info -> 401 with fallback message',
    r: run([null, false, undefined]),
    ok: (x) => x.status === 401 && x.body && x.body.message === 'Invalid credentials',
  },
  {
    name: 'user + info message -> 422',
    r: run([null, { _id: 'u1' }, { message: 'Email not verified.' }]),
    ok: (x) => x.status === 422,
  },
  {
    name: 'valid user -> next() and req.user set',
    r: run([null, { _id: 'u1' }, undefined]),
    ok: (x) => x.next === undefined && x.req.user && x.req.user._id === 'u1' && x.status === null,
  },
  {
    name: 'passport error -> forwarded to next(err)',
    r: run([new Error('boom'), false, undefined]),
    ok: (x) => x.next instanceof Error,
  },
];

let pass = 0;
for (const c of cases) {
  const ok = c.ok(c.r);
  if (ok) pass++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.name}  -> status=${c.r.status} body=${JSON.stringify(c.r.body)}`,
  );
}

// The regression this file exists for: a rejected password must never look like
// a missing route.
const regression = cases[0].r.status !== 404;
console.log(`\n${regression ? 'PASS' : 'FAIL'}  regression guard: rejected login is not 404`);
if (regression) pass++;

const total = cases.length + 1;
console.log(`\n${pass}/${total} checks passed`);
process.exit(pass === total ? 0 : 1);
