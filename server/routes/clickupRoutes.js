const express = require('express');
const clickupController = require('../controllers/clickupController');

const authMiddleware = require('../middlewares/authMiddleware');
const accessMiddleware = require('../middlewares/accessMiddleware');

const router = express.Router();

function pickMiddleware(moduleValue, possibleNames, label) {
  if (typeof moduleValue === 'function') return moduleValue;

  for (const name of possibleNames) {
    if (moduleValue && typeof moduleValue[name] === 'function') {
      return moduleValue[name];
    }
  }

  throw new Error(`[clickupRoutes] Middleware não encontrado: ${label}`);
}

const verifyToken = pickMiddleware(
  authMiddleware,
  ['verifyToken', 'authMiddleware', 'authenticateToken', 'requireAuth'],
  'JWT/auth'
);

const requireClickupAccess = pickMiddleware(
  {
    requireAutomacoesAccess: accessMiddleware.requireAutomacoesAccess,
    requireAdmin: authMiddleware.requireAdmin,
  },
  ['requireAutomacoesAccess', 'requireAdmin'],
  'requireAutomacoesAccess ou requireAdmin'
);

// GET /api/clickup/executivo/resumo
router.get('/executivo/resumo', verifyToken, requireClickupAccess, clickupController.getResumoExecutivo);

module.exports = router;
