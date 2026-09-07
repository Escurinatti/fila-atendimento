# Fila de atendimento — Estágio 1 (só leitura)

Uma página só. Mostra quem está esperando resposta no Instagram das duas marcas
(Mapa del Tarot e Carto Maps), há quanto tempo, quanto resta das janelas da Meta
(24h padrão e 7 dias com `human_agent`), e a ficha da compra ao lado.

Não envia nada. Não escreve em tabela nenhuma.

## Como funciona

- `index.html` — a tela. HTML puro + supabase-js do CDN. Sem build.
- `sql/001_fila_leitura.sql` — o que foi aplicado no banco (projeto `vupxofhfgqnqsbwzmndy`):
  - tabela `admins` (quem pode ver) — hoje `gabecarto@gmail.com` e `bielmado@gmail.com`
  - função `eh_admin()`
  - política `admin le tudo` (só SELECT) nas tabelas do atendimento
  - funções `fila_atendimento(p_dias)`, `atendimento_travados()`, `ficha_cliente(autor_id, marca)`

A página usa a chave pública do Supabase. Isso é seguro porque o banco só
devolve linhas para quem está logado E está em `admins`. Qualquer cliente da
biblioteca que logar aqui vê a tela "Sem acesso" e zero linhas.

## Login

E-mail + senha do Supabase Auth (o mesmo Auth da biblioteca). Se não souber a
senha: "Esqueci a senha" manda o link. Para o link voltar para esta tela (e não
para a biblioteca), a URL dela precisa estar em
Supabase → Authentication → URL Configuration → Redirect URLs.

## Publicar

Ver a seção "Publicar" na daily de 06/09/2026 no cofre. Em resumo: repositório
no GitHub com este conteúdo e GitHub Pages ligado na branch main, raiz.
Para atualizar depois: edite `index.html`, commit, push.

## Adicionar ou tirar alguém

    insert into public.admins (email, nome) values ('pessoa@exemplo.com', 'Nome');
    delete from public.admins where email = 'pessoa@exemplo.com';

Vale na hora, sem redeploy.

## Próximos estágios

2. Caixa de resposta → upsert em `fila_respostas` (o despachante do n8n envia).
3. Botões: reenviar arquivos por e-mail, passo a passo do reembolso, marcar resolvido.
