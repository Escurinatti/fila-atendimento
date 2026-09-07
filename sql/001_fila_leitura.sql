-- Estágio 1 da caixa de entrada: só leitura, só para admins.
-- Aplicado em 2026-09-06 via MCP (apply_migration "fila_atendimento_leitura").

-- 1) Quem pode abrir a tela --------------------------------------------------
create table if not exists public.admins (
  email     text primary key,
  nome      text,
  criado_em timestamptz not null default now()
);
comment on table public.admins is
  'Quem pode abrir a tela de atendimento. Lido por eh_admin(). Sem policy: só service role mexe.';
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

insert into public.admins (email, nome) values
  ('gabecarto@gmail.com', 'Gabriel'),
  ('bielmado@gmail.com',  'Gabriel (bielmado)')
on conflict (email) do nothing;

create or replace function public.eh_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.eh_admin() from public;
grant execute on function public.eh_admin() to authenticated;

-- 2) Admin lê (SELECT) as tabelas do atendimento. Nada de escrita. ------------
do $$
declare t text;
begin
  foreach t in array array[
    'conversas','fila_respostas','atendimento_estado','compras','acessos_membros',
    'itens_membros','reembolsos','pausas','correcoes_resposta','respostas_pendentes',
    'verificacoes_compra','comentarios_respondidos'
  ] loop
    execute format('drop policy if exists "admin le tudo" on public.%I', t);
    -- (select ...) faz o Postgres avaliar eh_admin() uma vez por consulta (InitPlan),
    -- não uma vez por linha. Sem isso a fila levava 5,9 s; com isso, bem menos.
    execute format('create policy "admin le tudo" on public.%I for select to authenticated using ((select public.eh_admin()))', t);
  end loop;
end $$;

-- 3) A fila: conversa em que a última palavra é do cliente --------------------
-- Diferenças em relação à consulta feita à mão em 06/09:
--   * conta como "saída" também o enviado_em de fila_respostas, porque o
--     despachante NÃO grava em conversas (Lorena aparecia pendente já respondida)
--   * espera_desde = primeira mensagem sem resposta, não a última
--   * n_midia = mensagens com texto vazio (imagem/print) no trecho sem resposta
--   * agora = now() do servidor, para a tela nunca calcular prazo com relógio velho
create or replace function public.fila_atendimento(p_dias int default 7)
returns table (
  agora              timestamptz,
  autor              text,
  autor_id           text,
  marca              text,
  canal              text,
  ultima_entrada     timestamptz,
  ultima_saida       timestamptz,
  espera_desde       timestamptz,
  horas_espera       numeric,
  janela_24h_h       numeric,
  janela_7d_h        numeric,
  n_sem_resposta     int,
  n_midia            int,
  categorias         text,
  ultimo_texto       text,
  ultima_mensagem_id text,
  estado             text,
  email_informado    text,
  pausado_ate        timestamptz,
  pausado_motivo     text,
  resposta_na_fila   boolean,
  urgencia           int,
  motivo_urgencia    text
)
language sql stable security invoker
set search_path = public
as $$
with recente as (
  select * from conversas
  where criado_em >= now() - make_interval(days => greatest(p_dias, 1))
    and nullif(autor_id, '') is not null
),
saidas_fila as (
  select f.marca,
         case when f.canal = 'dm' then 'dm' else 'comentario' end as canal,
         case when f.canal = 'dm' then f.ref else c.autor_id end as autor_id,
         f.enviado_em
  from fila_respostas f
  left join conversas c on f.canal <> 'dm' and c.mensagem_id = f.ref
  where f.enviado_em is not null
),
grupo as (
  select r.autor_id, r.marca, r.canal,
    max(r.autor) filter (where nullif(r.autor, '') is not null)  as autor,
    max(r.criado_em) filter (where r.direcao = 'entrada')          as ultima_entrada,
    greatest(
      coalesce(max(r.criado_em) filter (where r.direcao = 'saida'), '2000-01-01'::timestamptz),
      coalesce((select max(s.enviado_em) from saidas_fila s
                where s.autor_id = r.autor_id and s.canal = r.canal and s.marca = r.marca),
               '2000-01-01'::timestamptz)
    ) as ultima_saida
  from recente r
  group by 1, 2, 3
),
pend as (
  select g.*,
    (select min(x.criado_em) from recente x
      where x.autor_id = g.autor_id and x.marca = g.marca and x.canal = g.canal
        and x.direcao = 'entrada' and x.criado_em > g.ultima_saida)            as espera_desde,
    (select count(*) from recente x
      where x.autor_id = g.autor_id and x.marca = g.marca and x.canal = g.canal
        and x.direcao = 'entrada' and x.criado_em > g.ultima_saida)            as n_sem_resposta,
    (select count(*) from recente x
      where x.autor_id = g.autor_id and x.marca = g.marca and x.canal = g.canal
        and x.direcao = 'entrada' and x.criado_em > g.ultima_saida
        and coalesce(x.texto, '') = '')                                        as n_midia,
    (select string_agg(distinct x.categoria, ', ' order by x.categoria) from recente x
      where x.autor_id = g.autor_id and x.marca = g.marca and x.canal = g.canal
        and x.direcao = 'entrada' and x.criado_em > g.ultima_saida
        and x.categoria is not null)                                            as categorias,
    (select x.texto from recente x
      where x.autor_id = g.autor_id and x.marca = g.marca and x.canal = g.canal
        and x.direcao = 'entrada' order by x.criado_em desc limit 1)            as ultimo_texto,
    (select x.mensagem_id from recente x
      where x.autor_id = g.autor_id and x.marca = g.marca and x.canal = g.canal
        and x.direcao = 'entrada' order by x.criado_em desc limit 1)            as ultima_mensagem_id
  from grupo g
  where g.ultima_entrada > g.ultima_saida
),
calc as (
  select p.*,
    round(extract(epoch from now() - p.espera_desde) / 3600, 1)                as horas_espera,
    case when p.canal = 'dm'
         then round(24  - extract(epoch from now() - p.ultima_entrada) / 3600, 1) end as janela_24h_h,
    case when p.canal = 'dm'
         then round(168 - extract(epoch from now() - p.ultima_entrada) / 3600, 1) end as janela_7d_h,
    e.estado, e.email_informado,
    greatest(e.pausado_ate, pa.pausado_ate)                                     as pausado_ate,
    coalesce(pa.motivo, e.pausado_motivo)                                       as pausado_motivo,
    exists (
      select 1 from fila_respostas f
      where f.enviado_em is null and f.marca = p.marca and (
        (p.canal = 'dm' and f.canal = 'dm' and f.ref = p.autor_id) or
        (p.canal = 'comentario' and f.canal <> 'dm' and f.ref in (
           select x.mensagem_id from recente x
           where x.autor_id = p.autor_id and x.canal = 'comentario' and x.mensagem_id is not null))
      )
    ) as resposta_na_fila
  from pend p
  left join lateral (
    select * from atendimento_estado e
    where e.conversa_id = p.autor_id and e.marca = p.marca
    order by e.atualizado_em desc limit 1
  ) e on true
  left join pausas pa on pa.conversa_id = p.autor_id
)
select
  now() as agora,
  c.autor, c.autor_id, c.marca, c.canal,
  c.ultima_entrada,
  nullif(c.ultima_saida, '2000-01-01'::timestamptz) as ultima_saida,
  c.espera_desde, c.horas_espera, c.janela_24h_h, c.janela_7d_h,
  c.n_sem_resposta::int, c.n_midia::int, c.categorias, c.ultimo_texto, c.ultima_mensagem_id,
  c.estado, c.email_informado, c.pausado_ate, c.pausado_motivo, c.resposta_na_fila,
  case
    when c.resposta_na_fila                                     then 8
    when coalesce(c.categorias, '') = 'SPAM'                    then 9
    when coalesce(c.categorias, '') = 'ELOGIO'                  then 7
    when c.categorias ~ 'FRAUDE'                                then 1
    when c.canal = 'comentario' and c.horas_espera >= 12        then 1
    when c.canal = 'dm' and c.janela_24h_h between 0 and 6      then 2
    when c.canal = 'dm' and c.janela_24h_h > 6                  then 3
    when c.canal = 'comentario'                                 then 3
    when c.canal = 'dm' and c.janela_7d_h > 0                   then 4
    else 5
  end as urgencia,
  case
    when c.resposta_na_fila                                     then 'Resposta já na fila, sai em até 5 min'
    when coalesce(c.categorias, '') = 'SPAM'                    then 'Spam'
    when coalesce(c.categorias, '') = 'ELOGIO'                  then 'Só agradecimento, não precisa de resposta'
    when c.categorias ~ 'FRAUDE'                                then 'Fala em fraude ou estafa'
    when c.canal = 'comentario' and c.horas_espera >= 12        then 'Comentário público parado'
    when c.canal = 'dm' and c.janela_24h_h between 0 and 6      then 'Janela de 24h fechando'
    when c.canal = 'dm' and c.janela_24h_h > 6                  then 'Janela de 24h aberta'
    when c.canal = 'comentario'                                 then 'Comentário recente'
    when c.canal = 'dm' and c.janela_7d_h > 0                   then 'Só com tag human_agent (até 7 dias)'
    else 'Fora das janelas: só por e-mail'
  end as motivo_urgencia
from calc c;
$$;
revoke all on function public.fila_atendimento(int) from public;
grant execute on function public.fila_atendimento(int) to authenticated;

-- 4) Quem está travado em atendimento_estado (independe da janela de dias) ----
create or replace function public.atendimento_travados()
returns table (
  agora            timestamptz,
  id               bigint,
  autor            text,
  conversa_id      text,
  marca            text,
  estado           text,
  email_informado  text,
  tentativas       int,
  atualizado_em    timestamptz,
  pausado_ate      timestamptz,
  pausado_motivo   text,
  ultima_entrada   timestamptz,
  ultima_saida     timestamptz,
  dias_parado      numeric,
  tem_compra       boolean,
  resposta_na_fila boolean
)
language sql stable security invoker
set search_path = public
as $$
  select
    now(),
    e.id,
    coalesce(nullif(e.autor, ''),
             (select max(c.autor) from conversas c
               where c.autor_id = e.conversa_id and nullif(c.autor, '') is not null)) as autor,
    e.conversa_id, e.marca, e.estado, e.email_informado, e.tentativas, e.atualizado_em,
    e.pausado_ate, e.pausado_motivo,
    (select max(c.criado_em) from conversas c where c.autor_id = e.conversa_id and c.direcao = 'entrada'),
    greatest(
      (select max(c.criado_em) from conversas c where c.autor_id = e.conversa_id and c.direcao = 'saida'),
      (select max(f.enviado_em) from fila_respostas f where f.ref = e.conversa_id)
    ),
    round(extract(epoch from now() - e.atualizado_em) / 86400, 1),
    exists (select 1 from compras k
             where nullif(e.email_informado, '') is not null
               and lower(k.email) = lower(e.email_informado)
               and k.status in ('APPROVED', 'COMPLETE', 'COMPLETED')),
    exists (select 1 from fila_respostas f where f.ref = e.conversa_id and f.enviado_em is null)
  from atendimento_estado e
  where e.estado is distinct from 'resolvido'
  order by e.atualizado_em asc;
$$;
revoke all on function public.atendimento_travados() from public;
grant execute on function public.atendimento_travados() to authenticated;

-- 5) A ficha de quem está na fila: e-mails, compras, arquivos, downloads ------
-- Status pago são TRÊS: APPROVED, COMPLETE, COMPLETED.
-- E-mails: o informado no estado + reembolsos + qualquer e-mail escrito nas
-- mensagens (o bot já deixou passar 3 vezes; a tela não pode depender dele).
create or replace function public.ficha_cliente(p_autor_id text, p_marca text default null)
returns jsonb
language sql stable security invoker
set search_path = public
as $$
with est as (
  select * from atendimento_estado e
  where e.conversa_id = p_autor_id and (p_marca is null or e.marca = p_marca)
  order by e.atualizado_em desc limit 1
),
emails as (
  select distinct lower(em) as email from (
    select email_informado em from est
    union all
    select r.email from reembolsos r where r.autor_id = p_autor_id
    union all
    select (regexp_matches(c.texto, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', 'g'))[1]
      from conversas c where c.autor_id = p_autor_id and c.direcao = 'entrada'
  ) s where nullif(trim(em), '') is not null
),
compras_x as (
  select k.transacao, k.email, k.nome, k.produto_id, k.produto_nome, k.status,
         k.status in ('APPROVED', 'COMPLETE', 'COMPLETED') as pago,
         k.valor, k.moeda,
         to_timestamp(k.aprovado_em / 1000.0) as aprovado_em,
         k.registrado_em,
         k.bruto -> 'data' -> 'purchase' -> 'payment' ->> 'type' as pagamento,
         coalesce(k.bruto -> 'data' -> 'purchase' -> 'checkout_country' ->> 'iso',
                  k.bruto -> 'data' -> 'buyer' -> 'address' ->> 'country_iso') as pais
  from compras k
  where lower(k.email) in (select email from emails)
),
itens_x as (
  select i.marca, i.titulo, i.bucket, i.arquivo, i.produto_id,
         (select max(a.criado_em) from acessos_membros a
           where a.evento = 'download' and a.arquivo = i.arquivo
             and lower(a.email) in (select email from emails)) as baixado_em
  from itens_membros i
  where i.ativo
    and exists (select 1 from compras_x k where k.pago and k.produto_id = any(i.libera_por))
  order by i.marca, i.ordem, i.id
),
acessos_x as (
  select a.evento, a.arquivo, a.criado_em, a.email
  from acessos_membros a
  where lower(a.email) in (select email from emails)
  order by a.criado_em desc limit 15
)
select jsonb_build_object(
  'agora',        now(),
  'estado',       (select to_jsonb(e) from est e),
  'pausa',        (select to_jsonb(p) from pausas p where p.conversa_id = p_autor_id),
  'emails',       (select coalesce(jsonb_agg(email order by email), '[]'::jsonb) from emails),
  'compras',      (select coalesce(jsonb_agg(to_jsonb(k) order by k.aprovado_em desc nulls last, k.registrado_em desc), '[]'::jsonb) from compras_x k),
  'itens',        (select coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb) from itens_x i),
  'acessos',      (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb) from acessos_x a),
  'n_logins',     (select count(*) from acessos_membros a where a.evento = 'login'    and lower(a.email) in (select email from emails)),
  'n_downloads',  (select count(*) from acessos_membros a where a.evento = 'download' and lower(a.email) in (select email from emails)),
  'reembolsos',   (select coalesce(jsonb_agg(to_jsonb(r) order by r.criado_em desc), '[]'::jsonb) from reembolsos r
                    where r.autor_id = p_autor_id or lower(r.email) in (select email from emails)),
  'verificacoes', (select coalesce(jsonb_agg(to_jsonb(v) - 'resposta_api' order by v.criado_em desc), '[]'::jsonb) from verificacoes_compra v where v.conversa_id = p_autor_id),
  'fila',         (select coalesce(jsonb_agg(to_jsonb(f) order by f.criado_em desc), '[]'::jsonb) from (
                     select * from fila_respostas f
                     where f.ref = p_autor_id
                        or f.ref in (select c.mensagem_id from conversas c where c.autor_id = p_autor_id and c.mensagem_id is not null)
                     order by f.criado_em desc limit 10) f),
  'pendentes',    (select coalesce(jsonb_agg(to_jsonb(r) order by r.criado_em desc), '[]'::jsonb) from respostas_pendentes r
                    where r.ref = p_autor_id
                       or r.ref in (select c.mensagem_id from conversas c where c.autor_id = p_autor_id and c.mensagem_id is not null))
);
$$;
revoke all on function public.ficha_cliente(text, text) from public;
grant execute on function public.ficha_cliente(text, text) to authenticated;
