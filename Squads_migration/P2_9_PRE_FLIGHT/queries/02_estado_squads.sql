-- P2.9 PRE-FLIGHT — 02_estado_squads.sql
-- SOMENTE LEITURA.
--
-- Estado atual das tabelas de Squad. Em producao pre-P2.9 todas devem estar
-- VAZIAS (a migracao nunca rodou). Estas queries confirmam isso e serao usadas
-- de novo DEPOIS do --apply para validar o resultado.
--
--   squads(id, nome, slug, ativo, ...)
--   squad_members(id, squad_id, user_id, is_primary, funcao['membro'|'coordenador'], ativo, ...)
--   cliente_squad_history(id, cliente_id, squad_id, inicio_em, fim_em, alterado_por, motivo, ...)
--     -> vinculo VIGENTE = fim_em IS NULL (no maximo 1 por cliente)
--   cliente_responsaveis(id, cliente_id, user_id, papel['gestor'|'auxiliar'|'designer'], ativo, ...)

\echo '=== 1. SQUADS ==='
SELECT id, slug, nome, ativo, created_at
FROM squads
ORDER BY ativo DESC, nome;

\echo '=== 2. TOTAIS ==='
SELECT
  (SELECT COUNT(*) FROM squads)                                        AS squads,
  (SELECT COUNT(*) FROM squads WHERE ativo)                            AS squads_ativos,
  (SELECT COUNT(*) FROM squad_members WHERE ativo)                     AS memberships_ativas,
  (SELECT COUNT(*) FROM cliente_squad_history WHERE fim_em IS NULL)    AS vinculos_cliente_squad_abertos,
  (SELECT COUNT(*) FROM cliente_responsaveis WHERE ativo)             AS responsaveis_ativos;

\echo '=== 3. MEMBERSHIPS ATIVAS (usuario -> squad) ==='
SELECT sm.user_id, u.email, u.nome, u.role, u.ativo AS user_ativo,
       s.slug AS squad_slug, s.ativo AS squad_ativo,
       sm.funcao, sm.is_primary
FROM squad_members sm
JOIN users u  ON u.id = sm.user_id
JOIN squads s ON s.id = sm.squad_id
WHERE sm.ativo = true
ORDER BY u.nome, s.slug;

\echo '=== 4. COORDENADORES (funcao = coordenador) ==='
SELECT u.email, u.nome, s.slug AS squad_slug
FROM squad_members sm
JOIN users u  ON u.id = sm.user_id
JOIN squads s ON s.id = sm.squad_id
WHERE sm.ativo = true AND sm.funcao = 'coordenador'
ORDER BY s.slug, u.nome;

\echo '=== 5. VINCULOS Cliente -> Squad ABERTOS (a carteira vigente) ==='
SELECT csh.cliente_id, c.slug AS cliente_slug, c.nome, c.ativo AS cliente_ativo,
       s.slug AS squad_slug, s.ativo AS squad_ativo,
       csh.inicio_em, csh.motivo
FROM cliente_squad_history csh
JOIN clientes c ON c.id = csh.cliente_id
JOIN squads s   ON s.id = csh.squad_id
WHERE csh.fim_em IS NULL
ORDER BY c.nome;

\echo '=== 6. RESPONSABILIDADES ATIVAS (organizacao — NAO e autorizacao) ==='
SELECT cr.cliente_id, c.slug AS cliente_slug, c.nome AS cliente_nome,
       cr.user_id, u.email, u.nome AS user_nome, cr.papel
FROM cliente_responsaveis cr
JOIN clientes c ON c.id = cr.cliente_id
JOIN users u    ON u.id = cr.user_id
WHERE cr.ativo = true
ORDER BY c.nome, cr.papel;

\echo '=== 7. CLIENTES ATIVOS SEM SQUAD (precisa ser 0 para auditoria.pronto) ==='
SELECT c.id AS cliente_id, c.slug AS cliente_slug, c.nome
FROM clientes c
LEFT JOIN cliente_squad_history csh
  ON csh.cliente_id = c.id AND csh.fim_em IS NULL
WHERE c.ativo = true AND csh.cliente_id IS NULL
ORDER BY c.nome;

\echo '=== 8. CLIENTES ATIVOS EM SQUAD INATIVO (precisa ser 0 para auditoria.pronto) ==='
SELECT c.id AS cliente_id, c.slug AS cliente_slug, c.nome,
       s.slug AS squad_slug
FROM clientes c
JOIN cliente_squad_history csh ON csh.cliente_id = c.id AND csh.fim_em IS NULL
JOIN squads s ON s.id = csh.squad_id
WHERE c.ativo = true AND s.ativo = false
ORDER BY c.nome;

\echo '=== 9. INTERNOS ATIVOS SEM MEMBERSHIP ATIVA (precisa ser 0 para auditoria.pronto) ==='
SELECT u.id AS user_id, u.email, u.nome, u.role
FROM users u
LEFT JOIN squad_members sm ON sm.user_id = u.id AND sm.ativo = true
WHERE u.ativo = true AND LOWER(u.role) IN ('user','membro','interno')
GROUP BY u.id, u.email, u.nome, u.role
HAVING COUNT(sm.id) = 0
ORDER BY u.nome;

\echo '=== 10. INTERNOS ATIVOS SEM PRINCIPAL (aviso; 1a membership vira principal na aplicacao) ==='
SELECT u.id AS user_id, u.email, u.nome
FROM users u
JOIN squad_members sm ON sm.user_id = u.id AND sm.ativo = true
WHERE u.ativo = true AND LOWER(u.role) IN ('user','membro','interno')
GROUP BY u.id, u.email, u.nome
HAVING COUNT(*) FILTER (WHERE sm.is_primary) = 0
ORDER BY u.nome;
