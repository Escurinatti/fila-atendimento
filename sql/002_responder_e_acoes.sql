-- Estágio 2 da caixa de entrada: idioma, resposta e ações.
-- Aplicado em 2026-09-06 via MCP (apply_migration "fila_atendimento_acoes").
-- Toda escrita passa por função SECURITY DEFINER que exige eh_admin() e valida
-- a entrada. A tela nunca escreve direto em tabela. Nada aqui envia mensagem:
-- quem envia continua sendo o n8n (📤 Fila de respostas, a cada 5 min).

-- 0) Rastro de quem pôs a resposta na fila ------------------------------------
alter table public.fila_respostas add column if not exists origem text;
comment on column public.fila_respostas.origem is 'null = n8n/rotina; tela:<email> = posta pela tela de atendimento';

-- 1) Idioma de quem escreve (não da marca) ------------------------------------
create or replace function public.detectar_idioma(p_texto text, p_marca text default null)
returns text
language plpgsql immutable
as $$
declare
  t text := ' ' || regexp_replace(lower(coalesce(p_texto, '')), '[^a-záéíóúñüçãõâêôàèìòùäöß¿¡]+', ' ', 'g') || ' ';
  es int := 0; en int := 0; pt int := 0; it int := 0; de int := 0;
  w text;
  function_score int;
begin
  foreach w in array array[' el ',' la ',' que ',' no ',' me ',' mi ',' hola ',' puedo ',' compré ',' compre ',' gracias ',' por ',' para ',' con ',' una ',' es ',' quiero ',' tengo ',' cómo ',' como ',' acceso ',' correo ',' pero ',' ya ',' ¿',' ¡',' sí ',' está ',' del ',' los ',' las ',' también ',' hice ',' cuando ',' porque ',' buenas ',' buenos ',' todavía ',' aún ',' nada ',' pago ',' pagué '] loop
    es := es + coalesce(array_length(regexp_split_to_array(t, w), 1), 1) - 1;
  end loop;
  foreach w in array array[' the ',' i ',' is ',' it ',' to ',' and ',' my ',' you ',' this ',' for ',' can ',' not ',' have ',' want ',' hi ',' hello ',' please ',' thanks ',' thank ',' bought ',' refund ',' access ',' still ',' just ',' but ',' any ',' with ',' how ',' what ',' need ',' email ',' link ',' payment ',' one ',' or ',' are ',' was ',' been ',' after ',' update '] loop
    en := en + coalesce(array_length(regexp_split_to_array(t, w), 1), 1) - 1;
  end loop;
  foreach w in array array[' não ',' nao ',' você ',' voce ',' eu ',' obrigado ',' obrigada ',' quero ',' consigo ',' já ',' comprei ',' está ',' isso ',' pra ',' meu ',' minha ',' bom dia ',' boa tarde ',' boa noite ',' também ',' ainda ',' acesso ',' tudo ',' tenho ',' fazer ',' então ',' oi '] loop
    pt := pt + coalesce(array_length(regexp_split_to_array(t, w), 1), 1) - 1;
  end loop;
  foreach w in array array[' il ',' che ',' non ',' per ',' sono ',' ho ',' grazie ',' vorrei ',' anche ',' della ',' questo ',' ciao ',' buongiorno ',' buonasera ',' ancora ',' accesso ',' pagato ',' comprato ',' mi ',' ma ',' come ',' quando ',' perché ',' salve '] loop
    it := it + coalesce(array_length(regexp_split_to_array(t, w), 1), 1) - 1;
  end loop;
  foreach w in array array[' ich ',' nicht ',' und ',' das ',' ist ',' die ',' der ',' hallo ',' danke ',' habe ',' bitte ',' kann ',' mit ',' auf ',' ein ',' eine ',' noch ',' zugang ',' gekauft ',' bezahlt ',' aber ',' wie ',' wann ',' guten '] loop
    de := de + coalesce(array_length(regexp_split_to_array(t, w), 1), 1) - 1;
  end loop;

  -- 'mi' e 'no' pesam em ES e IT; 'con', 'para', 'por' em ES e PT: por isso
  -- as listas privilegiam palavras distintivas. Empate ou nada → marca.
  function_score := greatest(es, en, pt, it, de);
  if function_score >= 2 then
    if es = function_score and es > en and es > pt and es > it and es > de then return 'es'; end if;
    if en = function_score and en > es and en > pt and en > it and en > de then return 'en'; end if;
    if pt = function_score and pt > es and pt > en and pt > it and pt > de then return 'pt'; end if;
    if it = function_score and it > es and it > en and it > pt and it > de then return 'it'; end if;
    if de = function_score and de > es and de > en and de > pt and de > it then return 'de'; end if;
  end if;
  return case p_marca when 'cartomaps' then 'en' when 'atlante_delle_carte' then 'it' when 'der_kartenatlas' then 'de' else 'es' end;
end $$;

-- 2) Fila com idioma ----------------------------------------------------------
drop function if exists public.fila_atendimento(int);
create function public.fila_atendimento(p_dias int default 7)
returns table (
  agora              timestamptz,
  autor              text,
  autor_id           text,
  marca              text,
  canal              text,
  idioma             text,
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
        and x.direcao = 'entrada' order by x.criado_em desc limit 1)            as ultima_mensagem_id,
    detectar_idioma(
      (select string_agg(x.texto, ' ') from (
         select texto from conversas x
         where x.autor_id = g.autor_id and x.direcao = 'entrada' and coalesce(x.texto,'') <> ''
         order by x.criado_em desc limit 6) x), g.marca)                        as idioma
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
  c.autor, c.autor_id, c.marca, c.canal, c.idioma,
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
revoke execute on function public.fila_atendimento(int) from public, anon;
grant execute on function public.fila_atendimento(int) to authenticated;

-- 3) Guarda comum -------------------------------------------------------------
create or replace function public.exigir_admin()
returns text
language plpgsql stable security definer
set search_path = public
as $$
declare em text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not exists (select 1 from public.admins a where lower(a.email) = em) then
    raise exception 'sem permissão' using errcode = '42501';
  end if;
  return em;
end $$;
revoke all on function public.exigir_admin() from public, anon;
grant execute on function public.exigir_admin() to authenticated;

-- 4) Responder: põe na fila, o n8n envia ---------------------------------------
-- Valida o que já quebrou na prática: ref de DM em canal de comentário (400),
-- domínio do vazamento, texto vazio, tamanho acima do limite do Instagram.
create or replace function public.responder(p_marca text, p_canal text, p_ref text, p_texto text)
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare em text := exigir_admin(); novo_id bigint; t text := trim(coalesce(p_texto, ''));
begin
  if p_marca not in ('mapa_del_tarot', 'cartomaps', 'atlante_delle_carte') then
    raise exception 'marca inválida: %', p_marca;
  end if;
  if p_canal not in ('dm', 'comentario_publico', 'comentario_privado') then
    raise exception 'canal inválido: %', p_canal;
  end if;
  if t = '' then raise exception 'texto vazio'; end if;
  if length(t) > 1000 then raise exception 'texto com % caracteres; o Instagram aceita até 1000', length(t); end if;
  if t ilike '%mapadeltarot.online%' then raise exception 'texto contém mapadeltarot.online (domínio do vazamento)'; end if;
  if p_canal = 'dm' and p_ref !~ '^[0-9]{10,20}$' then
    raise exception 'ref de DM tem que ser o autor_id numérico, recebi %', left(p_ref, 30);
  end if;
  if p_canal <> 'dm' and p_ref !~ '^[0-9]{15,20}$' then
    raise exception 'ref de comentário tem que ser o id numérico do comentário (17 dígitos), recebi %', left(p_ref, 30);
  end if;
  if p_canal <> 'dm' and not exists (select 1 from conversas c where c.mensagem_id = p_ref and c.canal = 'comentario') then
    raise exception 'não achei comentário com esse id em conversas';
  end if;
  if p_canal = 'comentario_publico' and (array_length(regexp_split_to_array(t, E'\n'), 1) > 3) then
    raise exception 'comentário público com mais de 3 linhas';
  end if;
  -- \y é a borda de palavra no regex do Postgres (\b seria backspace)
  if p_canal = 'comentario_publico' and t ~* '(https?://|www\.|\.(com|online|net|org|io)\y)' then
    raise exception 'comentário público com link ou domínio';
  end if;
  -- fila_respostas tem ÍNDICE único (canal, ref) — "fila_respostas_unica", não
  -- aparece em pg_constraint. Uma linha por conversa. Reenviar = sobrescrever a
  -- linha e zerar enviado_em/resultado (é assim que o n8n reenvia).
  insert into fila_respostas (marca, canal, ref, texto, origem, criado_em, enviado_em, resultado)
  values (p_marca, p_canal, p_ref, t, 'tela:' || em, now(), null, null)
  on conflict (canal, ref) do update
    set marca = excluded.marca, texto = excluded.texto, origem = excluded.origem,
        criado_em = now(), enviado_em = null, resultado = null
  returning id into novo_id;
  return novo_id;
end $$;
revoke all on function public.responder(text, text, text, text) from public, anon;
grant execute on function public.responder(text, text, text, text) to authenticated;

-- 5) Cancelar antes de sair ----------------------------------------------------
create or replace function public.cancelar_resposta(p_id bigint)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare em text := exigir_admin(); n int;
begin
  delete from fila_respostas where id = p_id and enviado_em is null;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.cancelar_resposta(bigint) from public, anon;
grant execute on function public.cancelar_resposta(bigint) to authenticated;

-- 6) Estado do fluxo: resolver / reabrir ---------------------------------------
create or replace function public.marcar_estado(p_conversa_id text, p_marca text, p_estado text, p_autor text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
declare em text := exigir_admin(); n int;
begin
  if p_estado not in ('resolvido', 'aguardando_gabriel', 'aguardando_email') then
    raise exception 'estado inválido: %', p_estado;
  end if;
  update atendimento_estado set estado = p_estado
  where conversa_id = p_conversa_id and marca = p_marca;
  get diagnostics n = row_count;
  if n = 0 then
    insert into atendimento_estado (marca, conversa_id, autor, estado, contexto)
    values (p_marca, p_conversa_id, p_autor, p_estado, jsonb_build_object('origem', 'tela', 'por', em));
  end if;
end $$;
revoke all on function public.marcar_estado(text, text, text, text) from public, anon;
grant execute on function public.marcar_estado(text, text, text, text) to authenticated;

-- 7) Pausar / despausar o bot numa conversa ------------------------------------
-- O nó "Humano ou pausa" do n8n lê a tabela pausas: com pausa ativa o bot cala
-- (exceto entrega de acesso com compra achada). Serve para o humano responder
-- sem o bot atropelar com "vos", "160 páginas" ou promessa de reembolso.
create or replace function public.pausar_bot(p_conversa_id text, p_marca text, p_autor text, p_horas int)
returns timestamptz
language plpgsql security definer
set search_path = public
as $$
declare em text := exigir_admin(); ate timestamptz;
begin
  if coalesce(p_horas, 0) <= 0 then
    delete from pausas where conversa_id = p_conversa_id;
    return null;
  end if;
  ate := now() + make_interval(hours => least(p_horas, 24 * 14));
  insert into pausas (conversa_id, marca, autor, motivo, pausado_ate)
  values (p_conversa_id, p_marca, p_autor, 'humano atendendo pela tela (' || em || ')', ate)
  on conflict (conversa_id) do update
    set pausado_ate = excluded.pausado_ate, motivo = excluded.motivo, marca = excluded.marca, autor = coalesce(excluded.autor, pausas.autor);
  return ate;
end $$;
revoke all on function public.pausar_bot(text, text, text, int) from public, anon;
grant execute on function public.pausar_bot(text, text, text, int) to authenticated;

-- 8) Registrar pedido de reembolso ---------------------------------------------
-- Política de 05/09: perguntar o motivo, salvar, mandar o passo a passo da
-- Hotmart mesmo sem resposta. Nunca prometer; quem processa é a Hotmart.
create or replace function public.registrar_reembolso(
  p_marca text, p_canal text, p_autor text, p_autor_id text, p_email text,
  p_transacoes text[], p_valor_total numeric, p_moeda text,
  p_motivo text, p_motivo_origem text, p_orientado boolean, p_observacao text default null)
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare em text := exigir_admin(); novo_id bigint;
begin
  if p_motivo_origem not in ('perguntado', 'espontaneo', 'sem_resposta') then
    raise exception 'motivo_origem inválido';
  end if;
  insert into reembolsos (marca, canal, autor, autor_id, email, transacoes, valor_total, moeda,
                          motivo, motivo_origem, pedido_em, orientado_em, observacao)
  values (p_marca, p_canal, p_autor, p_autor_id, lower(nullif(p_email, '')), p_transacoes, p_valor_total, p_moeda,
          nullif(p_motivo, ''), p_motivo_origem, now(), case when p_orientado then now() end,
          concat_ws(' | ', nullif(p_observacao, ''), 'registrado pela tela por ' || em))
  returning id into novo_id;
  return novo_id;
end $$;
revoke all on function public.registrar_reembolso(text, text, text, text, text, text[], numeric, text, text, text, boolean, text) from public, anon;
grant execute on function public.registrar_reembolso(text, text, text, text, text, text[], numeric, text, text, text, boolean, text) to authenticated;

-- 9) "Respondi por fora" ---------------------------------------------------------
-- Quando a resposta foi dada pelo app do Instagram (ex.: DM fora da janela),
-- grava uma saída em conversas para a fila parar de mostrar a pessoa.
create or replace function public.marcar_respondido_fora(p_autor_id text, p_marca text, p_canal text, p_nota text default null)
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare em text := exigir_admin(); novo_id bigint; a text;
begin
  if p_canal not in ('dm', 'comentario') then raise exception 'canal inválido'; end if;
  select max(autor) into a from conversas where autor_id = p_autor_id and nullif(autor, '') is not null;
  insert into conversas (marca, canal, conversa_id, autor, autor_id, direcao, texto, categoria)
  values (p_marca, p_canal, p_autor_id, a, p_autor_id, 'saida',
          '[respondido à mão no Instagram por ' || em || ']' || coalesce(' ' || nullif(p_nota, ''), ''), 'HUMANO')
  returning id into novo_id;
  return novo_id;
end $$;
revoke all on function public.marcar_respondido_fora(text, text, text, text) from public, anon;
grant execute on function public.marcar_respondido_fora(text, text, text, text) to authenticated;
