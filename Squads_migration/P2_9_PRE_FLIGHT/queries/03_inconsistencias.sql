-- P2.9 PRE-FLIGHT — 03_inconsistencias.sql
-- SOMENTE LEITURA.
--
-- Espelha as checagens de squadsMigracaoService.auditoria() (P2.8 BLOCO Y).
-- Em producao pre-P2.9 tudo deve voltar VAZIO (nao ha dados de Squad).
-- Rodar de novo DEPOIS do --apply: BLOQUEANTES precisam voltar 0.

\echo '=== BLOQUEANTE 1: mesmo cliente com 2+ vinculos Cliente->Squad ABERTOS ==='
\echo '(carteira nao-deterministica; o rollout NAO pode acontecer nesse estado)'
SELECT csh.cliente_id, c.slug, c.nome, COUNT(*) AS vinculos_abertos,
       ARRAY_AGG(csh.squad_id ORDER BY csh.squad_id) AS squad_ids
FROM cliente_squad_history csh
JOIN clientes c ON c.id = csh.cliente_id
WHERE csh.fim_em IS NULL
GROUP BY csh.cliente_id, c.slug, c.nome
HAVING COUNT(*) > 1
ORDER BY c.nome;

\echo '=== BLOQUEANTE 2: usuario com 2+ memberships principais ativas ==='
\echo '(bloqueado pelo indice parcial unico, mas checamos por dados legados)'
SELECT sm.user_id, u.email, u.nome, COUNT(*) AS principais_ativas
FROM squad_members sm
JOIN users u ON u.id = sm.user_id
WHERE sm.ativo = true AND sm.is_primary = true
GROUP BY sm.user_id, u.email, u.nome
HAVING COUNT(*) > 1;

\echo '=== BLOQUEANTE 3: interno ativo com membership APENAS em Squad(s) inativo(s) ==='
SELECT u.id AS user_id, u.email, u.nome
FROM users u
JOIN squad_members sm ON sm.user_id = u.id AND sm.ativo = true
JOIN squads s ON s.id = sm.squad_id
WHERE u.ativo = true AND LOWER(u.role) IN ('user','membro','interno')
GROUP BY u.id, u.email, u.nome
HAVING COUNT(*) FILTER (WHERE s.ativo = true) = 0;

\echo '=== ATENCAO 1: responsavel por cliente que NAO e membro do Squad do cliente ==='
\echo '(nao e falha de autorizacao; com enforcement ON essa pessoa perde acesso ao cliente pelo qual responde)'
SELECT cr.cliente_id, c.slug, c.nome, cr.user_id, u.email, u.nome AS user_nome, cr.papel
FROM cliente_responsaveis cr
JOIN clientes c ON c.id = cr.cliente_id AND c.ativo = true
JOIN users u    ON u.id = cr.user_id AND u.ativo = true
WHERE cr.ativo = true
  AND LOWER(u.role) IN ('user','membro','interno')
  AND NOT EXISTS (
    SELECT 1
    FROM cliente_squad_history csh
    JOIN squads s ON s.id = csh.squad_id AND s.ativo = true
    JOIN squad_members sm ON sm.squad_id = s.id AND sm.user_id = cr.user_id AND sm.ativo = true
    WHERE csh.cliente_id = cr.cliente_id AND csh.fim_em IS NULL
  )
ORDER BY c.nome, cr.papel;

\echo '=== ATENCAO 2: membership ATIVA de usuario DESATIVADO ==='
\echo '(nao concede acesso — o login barra — mas suja a contagem de membros do Squad)'
SELECT sm.user_id, u.nome AS user_nome, u.email, s.slug AS squad_slug
FROM squad_members sm
JOIN users u  ON u.id = sm.user_id
JOIN squads s ON s.id = sm.squad_id
WHERE sm.ativo = true AND u.ativo = false
ORDER BY s.slug;

\echo '=== ATENCAO 3: vinculo Cliente->Squad aberto para CLIENTE inativo ==='
SELECT c.id AS cliente_id, c.slug, c.nome, s.slug AS squad_slug
FROM cliente_squad_history csh
JOIN clientes c ON c.id = csh.cliente_id
JOIN squads s   ON s.id = csh.squad_id
WHERE csh.fim_em IS NULL AND c.ativo = false
ORDER BY c.nome;

\echo '=== CONTEXTO: contagem final que alimenta auditoria.pronto ==='
\echo '(compare com: node server/sql/squads-migrate.js --audit)'
SELECT
  (SELECT COUNT(*) FROM clientes c
     LEFT JOIN cliente_squad_history csh ON csh.cliente_id=c.id AND csh.fim_em IS NULL
    WHERE c.ativo=true AND csh.cliente_id IS NULL)                    AS clientes_sem_squad,
  (SELECT COUNT(*) FROM clientes c
     JOIN cliente_squad_history csh ON csh.cliente_id=c.id AND csh.fim_em IS NULL
     JOIN squads s ON s.id=csh.squad_id
    WHERE c.ativo=true AND s.ativo=false)                            AS clientes_em_squad_inativo,
  (SELECT COUNT(*) FROM (
     SELECT u.id FROM users u
       LEFT JOIN squad_members sm ON sm.user_id=u.id AND sm.ativo=true
      WHERE u.ativo=true AND LOWER(u.role) IN ('user','membro','interno')
      GROUP BY u.id HAVING COUNT(sm.id)=0
   ) x)                                                              AS internos_sem_membership;
