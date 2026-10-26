const passport = require('passport');
const { logger } = require('@librechat/data-schemas');

const requireLocalAuth = (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) {
      logger.error('[requireLocalAuth] Error at passport.authenticate:', err);
      return next(err);
    }
    if (!user) {
      logger.debug('[requireLocalAuth] Error: No user');
      /* 401, not 404: a rejected password is an authentication failure, and the
         route exists. Answering 404 told every non-browser consumer — uptime
         checks, WAF rules, client retry logic, 4xx dashboards — that the login
         endpoint itself was missing. `info` carries Passport's message (e.g.
         "Incorrect password.") so the client can still render it. */
      return res.status(401).send(info ?? { message: 'Invalid credentials' });
    }
    if (info && info.message) {
      logger.debug('[requireLocalAuth] Error: ' + info.message);
      return res.status(422).send({ message: info.message });
    }
    req.user = user;
    next();
  })(req, res, next);
};

module.exports = requireLocalAuth;
