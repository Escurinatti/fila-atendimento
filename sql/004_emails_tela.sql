-- Rastro dos e-mails de reenvio de arquivos enviados pela tela (função de borda reenviar-email → Resend).
-- Aplicado em 2026-09-06 via MCP (apply_migration "fila_atendimento_emails_tela").
create table if not exists public.emails_tela (
  id           bigserial primary key,
  autor_id     text,
  marca        text not null,
  idioma       text,
  para         text not null,
  assunto      text,
  arquivos     jsonb,
  base         text,             -- 'compra' | 'confirmacao_manual'
  resend_id    text,
  resultado    text,
  por          text,
  criado_em    timestamptz not null default now()
);
alter table public.emails_tela enable row level security;
drop policy if exists "admin le tudo" on public.emails_tela;
create policy "admin le tudo" on public.emails_tela for select to authenticated using ((select public.eh_admin()));
