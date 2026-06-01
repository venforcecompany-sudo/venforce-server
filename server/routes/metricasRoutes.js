// server/routes/metricasRoutes.js
// Montagem esperada em server/index.js:
//   const metricasRoutes = require('./routes/metricasRoutes');
//   app.use('/metricas', metricasRoutes);
//
// Proteção: authMiddleware + requireAutomacoesAccess (mesmo padrão de anuncios-meli).
const express = require('express');
const router = express.Router();

const { authMiddleware } = require('../middlewares/authMiddleware');
const { requireAutomacoesAccess } = require('../middlewares/accessMiddleware');
const ctrl = require('../controllers/metricasController');

router.use(authMiddleware, requireAutomacoesAccess);

router.get('/clientes', ctrl.clientes);
router.get('/resumo',   ctrl.resumo);

module.exports = router;
