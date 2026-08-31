-- P2.9 PRE-FLIGHT — 01_inventario.sql
-- SOMENTE LEITURA. Nenhuma linha escreve. Rodar numa réplica / usuário readonly
-- se possível. NUNCA usar em produção com intenção de escrita.
--
-- Schema de referência (bootstrap server/index.js + migrations):
--   clientes(id, nome, slug, api_key, ativo, created_at)
--   cliente_contas(id, cliente_id, marketplace['meli'|'shopee'], nome, slug,
--                  external_account_id, is_primary, ativo, ...)
--   users(id, email, nome, ativo, role, created_at)
--   seller_clientes(id, user_id, cliente_id, marketplace, ativo, ...)
--   entregas_cliente(id, cliente_id NULLABLE, cliente_conta_id NULLABLE, tipo, periodo, publicado, ...)
--
-- Papéis: internos = user | membro | interno ; bypass = admin ;
--         fora de Squads = seller | shopee_reviewer

\echo '=== 1. TOTAIS DE CLIENTES ==='
SELECT
  COUNT(*)                             AS total,
  COUNT(*) FILTER (WHERE ativo)        AS ativos,
  COUNT(*) FILTER (WHERE NOT ativo)    AS inativos
FROM clientes;

\echo '=== 2. CLIENTES ATIVOS (lista-base para o mapeamento Cliente -> Squad) ==='
SELECT c.id AS cliente_id, c.slug AS cliente_slug, c.nome, c.ativo,
       COUNT(cc.id)                                  AS contas_total,
       COUNT(cc.id) FILTER (WHERE cc.ativo)          AS contas_ativas,
       COUNT(cc.id) FILTER (WHERE cc.marketplace='meli' AND cc.ativo)   AS contas_meli_ativas,
       COUNT(cc.id) FILTER (WHERE cc.marketplace='shopee' AND cc.ativo) AS contas_shopee_ativas
FROM clientes c
LEFT JOIN cliente_contas cc ON cc.cliente_id = c.id
WHERE c.ativo = true
GROUP BY c.id, c.slug, c.nome, c.ativo
ORDER BY c.nome;

\echo '=== 3. CLIENTES INATIVOS (referencia; nao entram no plano por padrao) ==='
SELECT id AS cliente_id, slug AS cliente_slug, nome, created_at
FROM clientes
WHERE ativo = false
ORDER BY nome;

\echo '=== 4. CLIENTES ATIVOS SEM NENHUMA ClienteConta ("possui conta? = nao") ==='
SELECT c.id AS cliente_id, c.slug AS cliente_slug, c.nome
FROM clientes c
LEFT JOIN cliente_contas cc ON cc.cliente_id = c.id
WHERE c.ativo = true
GROUP BY c.id, c.slug, c.nome
HAVING COUNT(cc.id) = 0
ORDER BY c.nome;

\echo '=== 5. CLIENTES ATIVOS COM 2+ ContasAtivas (Squad e do cliente; contas herdam) ==='
SELECT c.id AS cliente_id, c.slug AS cliente_slug, c.nome,
       COUNT(cc.id) FILTER (WHERE cc.ativo) AS contas_ativas,
       STRING_AGG(cc.marketplace || ':' || cc.slug, ', ' ORDER BY cc.slug)
         FILTER (WHERE cc.ativo) AS contas
FROM clientes c
JOIN cliente_contas cc ON cc.cliente_id = c.id
WHERE c.ativo = true
GROUP BY c.id, c.slug, c.nome
HAVING COUNT(cc.id) FILTER (WHERE cc.ativo) > 1
ORDER BY contas_ativas DESC, c.nome;

\echo '=== 6. CLIENTES ATIVOS COM 2+ contas ativas DO MESMO MARKETPLACE (atencao: ambiguidade de operacao) ==='
SELECT c.id AS cliente_id, c.slug AS cliente_slug, c.nome, cc.marketplace,
       COUNT(*) AS contas_ativas_desse_marketplace
FROM clientes c
JOIN cliente_contas cc ON cc.cliente_id = c.id AND cc.ativo = true
WHERE c.ativo = true
GROUP BY c.id, c.slug, c.nome, cc.marketplace
HAVING COUNT(*) > 1
ORDER BY c.nome, cc.marketplace;

\echo '=== 7. USUARIOS INTERNOS ATIVOS (lista-base para memberships) ==='
SELECT id AS user_id, email, nome, role, ativo, created_at
FROM users
WHERE ativo = true AND LOWER(role) IN ('user','membro','interno')
ORDER BY nome;

\echo '=== 8. USUARIOS INTERNOS INATIVOS (referencia; nao entram no plano por padrao) ==='
SELECT id AS user_id, email, nome, role
FROM users
WHERE ativo = false AND LOWER(role) IN ('user','membro','interno')
ORDER BY nome;

\echo '=== 9. ADMINS (bypass global; NAO precisam de membership) ==='
SELECT id AS user_id, email, nome, ativo
FROM users
WHERE LOWER(role) = 'admin'
ORDER BY nome;

\echo '=== 10. SELLERS / shopee_reviewer (fora de Squads; isolados por seller_clientes) ==='
SELECT u.id AS user_id, u.email, u.nome, u.role, u.ativo,
       COUNT(sc.id) FILTER (WHERE sc.ativo) AS clientes_vinculados
FROM users u
LEFT JOIN seller_clientes sc ON sc.user_id = u.id
WHERE LOWER(u.role) IN ('seller','shopee_reviewer')
GROUP BY u.id, u.email, u.nome, u.role, u.ativo
ORDER BY u.nome;

\echo '=== 11. CONTAS ORFAS (conta ativa cujo cliente esta inativo) ==='
SELECT cc.id AS conta_id, cc.slug AS conta_slug, cc.marketplace,
       c.id AS cliente_id, c.slug AS cliente_slug, c.ativo AS cliente_ativo
FROM cliente_contas cc
JOIN clientes c ON c.id = cc.cliente_id
WHERE cc.ativo = true AND c.ativo = false
ORDER BY c.nome;

\echo '=== 12. ENTREGAS ORFAS (cliente_id NULL; P2.7 ja fecha o acesso, contagem informativa) ==='
SELECT COUNT(*) AS entregas_sem_cliente,
       COUNT(*) FILTER (WHERE publicado) AS publicadas_sem_cliente
FROM entregas_cliente
WHERE cliente_id IS NULL;
