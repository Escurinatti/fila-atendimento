-- Estágio 2b: a IA da tela.
-- Aplicado em 2026-09-06 via MCP (apply_migration "fila_atendimento_ia_conhecimento").
-- A IA roda na função de borda `sugerir-resposta` (supabase/functions/). Ela recebe:
--   * ia_conhecimento (fatos sobre a empresa, editáveis pela tela)
--   * correcoes_resposta (o que o Gabriel já mandou mudar: preferências, não regras)
--   * a ficha e a conversa do cliente
-- e devolve a resposta + tradução em português. Cada chamada fica em ia_sugestoes.

create table if not exists public.ia_conhecimento (
  id            bigserial primary key,
  tema          text not null,
  texto         text not null,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  atualizado_por text
);
comment on table public.ia_conhecimento is 'Fatos sobre a empresa/produto que a IA da tela de atendimento recebe como contexto. Não é regra de escrita (isso está no prompt); é fato.';
alter table public.ia_conhecimento enable row level security;
drop policy if exists "admin le tudo" on public.ia_conhecimento;
create policy "admin le tudo" on public.ia_conhecimento for select to authenticated using ((select public.eh_admin()));

create or replace function public.salvar_conhecimento(p_id bigint, p_tema text, p_texto text)
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare em text := exigir_admin(); novo_id bigint;
begin
  if trim(coalesce(p_texto,'')) = '' then raise exception 'texto vazio'; end if;
  if p_id is null then
    insert into ia_conhecimento (tema, texto, atualizado_por) values (coalesce(nullif(trim(p_tema),''),'geral'), trim(p_texto), em) returning id into novo_id;
    return novo_id;
  end if;
  update ia_conhecimento set tema = coalesce(nullif(trim(p_tema),''), tema), texto = trim(p_texto), atualizado_em = now(), atualizado_por = em where id = p_id;
  return p_id;
end $$;
revoke all on function public.salvar_conhecimento(bigint, text, text) from public, anon;
grant execute on function public.salvar_conhecimento(bigint, text, text) to authenticated;

create or replace function public.apagar_conhecimento(p_id bigint)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare em text := exigir_admin(); n int;
begin
  update ia_conhecimento set ativo = false, atualizado_em = now(), atualizado_por = em where id = p_id and ativo;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.apagar_conhecimento(bigint) from public, anon;
grant execute on function public.apagar_conhecimento(bigint) to authenticated;

-- Registro das sugestões da IA (custo, auditoria). Só a função de borda escreve (service role).
create table if not exists public.ia_sugestoes (
  id            bigserial primary key,
  autor_id      text,
  marca         text,
  canal         text,
  idioma        text,
  modo          text,
  instrucao     text,
  rascunho      text,
  sugestao      text,
  sugestao_pt   text,
  modelo        text,
  tokens_entrada int,
  tokens_saida   int,
  por            text,
  criado_em      timestamptz not null default now()
);
alter table public.ia_sugestoes enable row level security;
drop policy if exists "admin le tudo" on public.ia_sugestoes;
create policy "admin le tudo" on public.ia_sugestoes for select to authenticated using ((select public.eh_admin()));

-- Semente (06/09/2026): fatos tirados do cofre e do que o Gabriel disse.
-- Editar pela tela (botão "Conhecimento da IA"), não aqui.
insert into public.ia_conhecimento (tema, texto, atualizado_por) values
('entrega', 'Os produtos são enviados direto para o e-mail da compra, como arquivos em link direto. Não existe mais "biblioteca" nem "área de membros" no discurso: nunca mandar ninguém para mapadeltarot.com nem pedir link mágico.', 'seed 06/09'),
('entrega', 'Quando a pessoa manda o e-mail para confirmar a compra e o e-mail é válido (compra paga encontrada), a gente manda o link da thank you com os produtos e reenvia o e-mail com os arquivos para ela acessar. Thank you ES: mapadeltaro.online/thank-you/ · EN: cartomaps.online/thank-you', 'seed 06/09'),
('entrega', 'Links de venda: ES mapadeltaro.online (SEM o "t" depois de taro) · EN cartomaps.online. NUNCA escrever mapadeltarot.online: é o domínio do vazamento.', 'seed 06/09'),
('produto', 'Mapa del Tarot / Complete Map of Tarot: produto 100% digital em PDF, 163 páginas, as 78 cartas do Rider Waite explicadas passo a passo. Não existe versão física, nada é enviado pelo correio. Pode ser impresso em casa; as páginas de prática têm espaço para escrever à mão.', 'seed 06/09'),
('produto', 'Dois planos, pagamento único, sem assinatura. ES: Básico 7,90 USD = só o Mapa, sem bônus; Completo 11,90 USD = Mapa + 4 bônus (Guía de Interpretación Intuitiva, Libro de las Tiradas, Cuidado y Conexión con tu Tarot, Mi Primera Tirada) + 150 exemplos de combinações. EN: Basic 9.90 USD; Complete 12.90 USD (Intuitive Interpretation Guide, Book of Spreads, Care and Connection, My First Spread). O preço converte para a moeda local no checkout.', 'seed 06/09'),
('produto', 'Complementos ES: Guía Flash: Arcanos Mayores (US$ 3,90), 80 Preguntas Poderosas (US$ 3,90), La Hoja de Trucos del Tarot (US$ 4,90). EN: 80 Powerful Questions, The Tarot Cheat Sheet, The Tarot Reading Journal. Italiano (Atlante delle Carte): Mappa Completa dei Tarocchi e complementos.', 'seed 06/09'),
('produto', 'O conteúdo NÃO é gerado por IA: cada página foi desenhada à mão, com base em referências de grandes obras do Tarot. O Mapa é o guia, não o baralho: ensina a ler as 78 cartas do Rider Waite; qualquer Rider Waite serve.', 'seed 06/09'),
('pagamento', 'Meios de pagamento na Hotmart. ES: cartão, PayPal, Nequi, Mercado Pago. EN: cartão, PayPal, Apple Pay, Google Pay. NÃO existe OXXO no checkout, nunca citar. Status pagos na Hotmart: APPROVED, COMPLETE e COMPLETED.', 'seed 06/09'),
('reembolso', 'Garantia de 7 dias incondicional, devolução de 100%. Quem processa o reembolso é a Hotmart, não nós: nunca prometer processar. Passo a passo: 1) refund.hotmart.com · 2) código da transação (formato HP0000000000) e e-mail da compra · 3) chega um token por e-mail, vale 15 minutos · 4) colar o token, escolher o motivo e Finalizar · 5) a Hotmart pede os dados bancários; cai em até 7 dias. Sempre perguntar o motivo, mas mandar o passo a passo mesmo sem resposta. Entregar o código da transação já preenchido (está na ficha).', 'seed 06/09'),
('empresa', 'Nunca dizer de que país a marca é, nem concordar com um país sugerido. Se perguntarem: somos um equipo digital que enseña Tarot / a digital team that teaches Tarot. Assinatura em inglês usada às vezes: "— Gabe".', 'seed 06/09'),
('canais', 'Instagram: DM pode ser respondida até 24h depois da última mensagem da pessoa (até 7 dias com a tag human_agent). Comentário público: no máximo 3 linhas e sem link; o link vai por privado. Resposta privada a comentário vale 7 dias, uma por comentário.', 'seed 06/09'),
('problemas conhecidos', 'Quando o cliente manda imagem (print do pagamento), o sistema não vê a imagem: pedir para escrever o e-mail da compra ou o código da transação em texto. Alguns clientes de inglês entraram na biblioteca em espanhol e viram "no payments received": não é falta de pagamento, era a página errada; hoje a entrega é por e-mail.', 'seed 06/09');
