const passport = require('passport');

jest.mock('passport', () => ({
  authenticate: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn() },
}));

const requireLocalAuth = require('./requireLocalAuth');

/** Build a fake (req, res, next) trio and let the middleware drive Passport. */
const run = (passportResult) => {
  const req = {};
  const res = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  passport.authenticate.mockImplementation((_strategy, callback) => {
    const [, , info] = passportResult;
    callback(...passportResult);
    return () => {};
  });
  requireLocalAuth(req, res, next);
  return { req, res, next, info: passportResult[2] };
};

describe('requireLocalAuth', () => {
  beforeEach(() => jest.clearAllMocks());

  it('answers 401 — not 404 — when the password is rejected', () => {
    const { res, next } = run([null, false, { message: 'Incorrect password.' }]);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ message: 'Incorrect password.' });
  });

  it('always sends a message body so a client can render something', () => {
    const { res } = run([null, false, undefined]);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ message: 'Invalid credentials' });
  });

  it('answers 422 for a rejection that carries a message but no user', () => {
    // Passport can return a user-shaped falsy value with an `info` message; the
    // 422 branch exists for that case and must keep its own status.
    const { res, next } = run([null, { _id: 'u1' }, { message: 'Email not verified.' }]);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes the authenticated user through untouched', () => {
    const user = { _id: 'u1', email: 'a@b.c' };
    const { req, next, res } = run([null, user, undefined]);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBe(user);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('forwards Passport errors to the error handler', () => {
    const err = new Error('strategy blew up');
    const { next } = run([err, false, undefined]);
    expect(next).toHaveBeenCalledWith(err);
  });
});
