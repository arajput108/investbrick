import { log } from '../logger.js';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { PortfolioError } from './service.js';

/** Authenticated portfolio API. The user id ALWAYS comes from the server-side session (req.user), never from the request. */
export function createPortfolioRouter({ service, auth, config = {} }) {
  const L = { general: 240, orders: 40, windowMs: 60e3, ...config.portfolioLimits };
  const perUser = (max) => rateLimit({
    windowMs: L.windowMs, limit: max, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => `u:${req.user.id}`,
    handler: (_q, res) => res.status(429).json({ error: 'You are doing that too quickly. Please slow down for a moment.', code: 'RATE_LIMITED' }),
  });

  const r = express.Router();
  r.use(auth.requireAuth, auth.guardUnsafe, perUser(L.general));

  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) {
      if (e instanceof PortfolioError) return res.status(e.status).json({ error: e.message, code: e.code });
      log.error('portfolio request failed', { err: e, requestId: req.id });
      res.status(500).json({ error: 'Something went wrong on our side. Nothing was changed. Please try again.' });
    }
  };
  const uid = (req) => req.user.id;
  const withPortfolio = async (req, result) => ({ result, portfolio: await service.view(uid(req)) });

  r.get('/', h((req) => service.getPortfolio(uid(req))));
  r.get('/history', h(async (req) => ({ points: await service.history(uid(req), req.query.limit) })));

  r.get('/orders', h(async (req) => ({ orders: await service.listOrders(uid(req), { status: req.query.status, limit: req.query.limit }) })));
  r.get('/orders/:id/events', h(async (req) => ({ events: await service.orderEvents(uid(req), req.params.id) })));
  r.post('/orders', perUser(L.orders), h(async (req) => withPortfolio(req, await service.placeOrder(uid(req), req.body))));
  r.delete('/orders/:id', perUser(L.orders), h(async (req) => withPortfolio(req, await service.cancelOrder(uid(req), req.params.id))));
  r.post('/basket', perUser(L.orders), h(async (req) => withPortfolio(req, await service.placeBasket(uid(req), req.body))));

  r.put('/watchlist/:symbol', h(async (req) => withPortfolio(req, await service.addWatch(uid(req), req.params.symbol))));
  r.delete('/watchlist/:symbol', h(async (req) => withPortfolio(req, await service.removeWatch(uid(req), req.params.symbol))));
  r.put('/learning', h(async (req) => withPortfolio(req, await service.setLearning(uid(req), req.body))));
  r.post('/import-guest', h(async (req) => withPortfolio(req, await service.importGuest(uid(req), req.body))));
  r.post('/import-guest/dismiss', h(async (req) => withPortfolio(req, await service.dismissGuestImport(uid(req)))));
  r.post('/reset', perUser(5), h(async (req) => withPortfolio(req, await service.reset(uid(req), req.body))));

  r.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return r;
}
