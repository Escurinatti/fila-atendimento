// Função de borda: reenvia por e-mail os arquivos a que o cliente tem direito (links assinados, 30 dias).
// Envia pelo Resend (segredo RESEND_API_KEY em Supabase → Edge Functions → Secrets).
// Trava: compra PAGA na ficha, ou confirmação manual do admin com justificativa (registrada).
// Regra do cofre (06/09): entrega é e-mail com os arquivos; nunca biblioteca. EN sai de bucket EN, ES de ES.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const VALIDADE_SEG = 60 * 60 * 24 * 30;
const REMETENTE = { mapa_del_tarot: "Mapa del Tarot <acceso@mapadeltarot.com>", cartomaps: "Carto Maps <acceso@mapadeltarot.com>", atlante_delle_carte: "Atlante delle Carte <acceso@mapadeltarot.com>" } as Record<string, string>;
const REPLY_TO = "gabecarto@gmail.com";

const TEXTOS: Record<string, { assunto: string; ola: string; intro: string; nota: string; fim: string; botao: string }> = {
  es: { assunto: "Tus archivos de {marca}", ola: "Hola{nome}", intro: "Aquí están tus archivos, para descargar directo. No hace falta plataforma ni contraseña.", nota: "Los enlaces funcionan por 30 días. Guarda los PDF en tu celular o computadora.", fim: "Si algo no abre, responde este correo y lo resuelvo.", botao: "Descargar" },
  en: { assunto: "Your {marca} files", ola: "Hi{nome}", intro: "Here are your files, as direct downloads. No platform, no password needed.", nota: "The links work for 30 days. Save the PDFs to your phone or computer.", fim: "If anything does not open, reply to this email and I will sort it out.", botao: "Download" },
  pt: { assunto: "Seus arquivos de {marca}", ola: "Olá{nome}", intro: "Aqui estão seus arquivos, para baixar direto. Sem plataforma nem senha.", nota: "Os links funcionam por 30 dias. Salve os PDFs no celular ou no computador.", fim: "Se algo não abrir, responda este e-mail e eu resolvo.", botao: "Baixar" },
  it: { assunto: "I tuoi file di {marca}", ola: "Ciao{nome}", intro: "Ecco i tuoi file, da scaricare direttamente. Nessuna piattaforma, nessuna password.", nota: "I link funzionano per 30 giorni. Salva i PDF sul telefono o sul computer.", fim: "Se qualcosa non si apre, rispondi a questa email e lo risolvo.", botao: "Scarica" },
};
const NOME_MARCA: Record<string, string> = { mapa_del_tarot: "Mapa del Tarot", cartomaps: "Carto Maps", atlante_delle_carte: "Atlante delle Carte" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const auth = req.headers.get("Authorization") ?? "";

    const comoUsuario = createClient(url, anon, { global: { headers: { Authorization: auth } } });
    const { data: u, error: uerr } = await comoUsuario.auth.getUser();
    if (uerr || !u?.user?.email) return json({ erro: "não logado" }, 401);
    const { data: ehAdmin } = await comoUsuario.rpc("eh_admin");
    if (!ehAdmin) return json({ erro: "sem permissão" }, 403);
    const por = u.user.email!;

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) return json({ erro: "O reenvio por e-mail ainda não está configurado: falta o segredo RESEND_API_KEY em Supabase → Edge Functions → Secrets." }, 503);

    const corpo = await req.json() as { autor_id: string; marca: string; para: string; idioma?: string; nome?: string; confirmo?: boolean; justificativa?: string; mensagem?: string };
    if (!corpo?.autor_id || !corpo?.marca || !corpo?.para) return json({ erro: "faltam autor_id, marca e para (e-mail)" }, 400);
    const para = corpo.para.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(para)) return json({ erro: "e-mail inválido: " + para }, 400);

    const admin = createClient(url, service);
    const { data: ficha, error: ferr } = await admin.rpc("ficha_cliente", { p_autor_id: corpo.autor_id, p_marca: corpo.marca });
    if (ferr) return json({ erro: "ficha: " + ferr.message }, 500);
    const f = (ficha ?? {}) as Record<string, any>;
    const pagas = ((f.compras ?? []) as any[]).filter((c) => c.pago);

    let itens: any[] = [];
    let base: "compra" | "confirmacao_manual";
    if (pagas.length) {
      itens = (f.itens ?? []) as any[];
      base = "compra";
    } else {
      if (!corpo.confirmo || !(corpo.justificativa ?? "").trim()) {
        return json({ erro: "Sem compra paga na ficha. Para reenviar mesmo assim, confirme à mão e escreva por que tem certeza (fica registrado).", precisa_confirmacao: true }, 409);
      }
      const { data: it } = await admin.from("itens_membros").select("id,marca,titulo,bucket,arquivo,produto_id,secao,ordem").eq("ativo", true).eq("marca", corpo.marca).eq("secao", "principal").order("ordem");
      itens = it ?? [];
      base = "confirmacao_manual";
      await admin.from("verificacoes_compra").insert({
        marca: corpo.marca, conversa_id: corpo.autor_id, autor: null, email_consultado: para,
        origem: "tela", resultado: "confianca_manual", qtd_encontrada: 0,
        acao_tomada: "e-mail com arquivos enviado por confirmação manual: " + corpo.justificativa!.trim(),
        decidido_por: por, aprovado: true,
      });
    }
    if (!itens.length) return json({ erro: "Nenhum arquivo cadastrado para esse produto (itens_membros)." }, 404);

    const links: { titulo: string; url: string }[] = [];
    const falhas: string[] = [];
    for (const i of itens) {
      const { data, error } = await admin.storage.from(i.bucket).createSignedUrl(i.arquivo, VALIDADE_SEG);
      if (error || !data?.signedUrl) { falhas.push(`${i.titulo}: ${error?.message ?? "sem url"}`); continue; }
      links.push({ titulo: i.titulo, url: data.signedUrl });
    }
    if (!links.length) return json({ erro: "Não consegui gerar nenhum link: " + falhas.join("; ") }, 500);

    const idioma = corpo.idioma && TEXTOS[corpo.idioma] ? corpo.idioma : (corpo.marca === "cartomaps" ? "en" : corpo.marca === "atlante_delle_carte" ? "it" : "es");
    const t = TEXTOS[idioma];
    const marcaNome = NOME_MARCA[corpo.marca] ?? corpo.marca;
    const nome = (corpo.nome ?? (pagas[0]?.nome ?? "")).trim().split(/\s+/)[0] ?? "";
    const assunto = t.assunto.replace("{marca}", marcaNome);
    const mensagemExtra = (corpo.mensagem ?? "").trim();

    const html = `<!doctype html><html><body style="margin:0;background:#f4f7fb;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f1f3d">
<div style="max-width:560px;margin:0 auto;padding:28px 16px">
  <div style="background:#fff;border-radius:16px;padding:28px 26px;border:1px solid #dfe6f0">
    <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5b6b85;font-weight:700">${esc(marcaNome)}</div>
    <h1 style="font-size:22px;margin:10px 0 6px">${esc(t.ola)}${nome ? " " + esc(nome) : ""} 👋</h1>
    <p style="font-size:15px;line-height:1.5;margin:0 0 18px">${esc(t.intro)}</p>
    ${mensagemExtra ? `<p style="font-size:15px;line-height:1.5;margin:0 0 18px;padding:12px 14px;background:#eef3fb;border-radius:10px">${esc(mensagemExtra).replace(/\n/g, "<br>")}</p>` : ""}
    ${links.map((l) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid #dfe6f0;border-radius:12px;margin:8px 0">
      <div style="font-size:15px;font-weight:600">${esc(l.titulo)}</div>
      <a href="${l.url}" style="background:#1f5eff;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:9px 14px;border-radius:9px;white-space:nowrap">${esc(t.botao)}</a>
    </div>`).join("")}
    <p style="font-size:13px;color:#5b6b85;line-height:1.5;margin:18px 0 6px">${esc(t.nota)}</p>
    <p style="font-size:14px;line-height:1.5;margin:0">${esc(t.fim)}</p>
  </div>
  <p style="text-align:center;font-size:12px;color:#8a97ad;margin-top:14px">${esc(marcaNome)}</p>
</div></body></html>`;
    const texto = `${t.ola}${nome ? " " + nome : ""}\n\n${t.intro}\n${mensagemExtra ? "\n" + mensagemExtra + "\n" : ""}\n${links.map((l) => `${l.titulo}: ${l.url}`).join("\n")}\n\n${t.nota}\n${t.fim}`;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: REMETENTE[corpo.marca] ?? REMETENTE.mapa_del_tarot, to: [para], reply_to: REPLY_TO, subject: assunto, html, text: texto, tags: [{ name: "origem", value: "tela" }, { name: "marca", value: corpo.marca }] }),
    });
    const rb = await r.json().catch(() => ({}));
    const ok = r.ok && rb?.id;
    await admin.from("emails_tela").insert({
      autor_id: corpo.autor_id, marca: corpo.marca, idioma, para, assunto, arquivos: links.map((l) => l.titulo), base,
      resend_id: rb?.id ?? null, resultado: ok ? "ok" : `resend ${r.status}: ${JSON.stringify(rb).slice(0, 300)}`, por,
    });
    if (!ok) return json({ erro: `Resend recusou (${r.status}): ${rb?.message ?? JSON.stringify(rb).slice(0, 200)}` }, 502);
    return json({ ok: true, resend_id: rb.id, para, idioma, base, arquivos: links.map((l) => l.titulo), falhas });
  } catch (e) {
    return json({ erro: "Erro: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
