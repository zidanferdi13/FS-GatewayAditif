'use strict';

const express = require('express');
const requirePin = require('../middleware/requirePin');

module.exports = (c) => {
  const router = express.Router();
  const h = fn => (req, res, next) => c[fn](req, res, next);

  router.get('/public', h('getPublic'));          // no PIN: thresholds only

  router.use(requirePin);                          // everything below needs the PIN
  router.get('/',                         h('get'));
  router.put('/',                         h('update'));
  router.get('/ports',                    h('ports'));
  router.get('/printers',                 h('printers'));
  router.post('/printer/test',            h('printerTest'));
  router.post('/scales/:scale/reconnect', h('reconnect'));

  return router;
};
