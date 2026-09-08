// Função de borda: apaga um comentário na Meta (Instagram ou Facebook) a pedido da tela.
// Instagram: token da marca em ig_tokens. Facebook: token de System User no segredo
// FB_SYSTEM_USER_TOKEN (Supabase → Edge Functions → Secrets) → token da Página via me/accounts.
// Depois marca conversas.apagado_em e grava uma saída "[respondido à mão …] comentário apagado"
// para a fila parar de cobrar resposta. Não dá para desfazer: a tela pede confirmação antes.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const PAGINAS: Record<string, string> = { mapa_del_tarot: "1161475443719342", cartomaps: "1167496503119385", atlante_delle_carte: "1248005775066560" };

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

    const corpo = await req.json() as { mensagem_id: string; marca: string; canal: string; autor_id: string; autor?: string };
    if (!corpo?.mensagem_id || !corpo?.marca || !corpo?.canal || !corpo?.autor_id) return json({ erro: "faltam mensagem_id, marca, canal e autor_id" }, 400);
    if (!PAGINAS[corpo.marca]) return json({ erro: "marca desconhecida: " + corpo.marca }, 400);
    if (!["comentario", "comentario_fb"].includes(corpo.canal)) return json({ erro: "só comentários podem ser apagados (canal comentario ou comentario_fb)" }, 400);

    const admin = createClient(url, service);
    const { data: rows, error: rerr } = await admin.from("conversas").select("id,apagado_em,direcao,canal,texto").eq("mensagem_id", corpo.mensagem_id).eq("marca", corpo.marca).limit(5);
    if (rerr) return json({ erro: "banco: " + rerr.message }, 500);
    const row = (rows ?? []).find((r: any) => r.direcao === "entrada");
    if (!row) return json({ erro: "comentário não encontrado no banco (só apago o que está registrado como entrada)" }, 404);
    if (row.apagado_em) return json({ ok: true, ja_apagado: true, apagado_em: row.apagado_em });

    let urlDel: string;
    if (corpo.canal === "comentario") {
      const { data: tk } = await admin.from("ig_tokens").select("token").eq("marca", corpo.marca).maybeSingle();
      if (!tk?.token) return json({ erro: "sem token do Instagram em ig_tokens para " + corpo.marca }, 500);
      urlDel = `https://graph.instagram.com/v21.0/${encodeURIComponent(corpo.mensagem_id)}?access_token=${encodeURIComponent(tk.token)}`;
    } else {
      const su = Deno.env.get("FB_SYSTEM_USER_TOKEN");
      if (!su) return json({ erro: "Apagar no Facebook ainda não está configurado: falta o segredo FB_SYSTEM_USER_TOKEN em Supabase → Edge Functions → Secrets (o mesmo token de System User que está na credencial do n8n)." }, 503);
      const r = await fetch(`https://graph.facebook.com/v21.0/me/accounts?fields=id,access_token&limit=50&access_token=${encodeURIComponent(su)}`);
      const d = await r.json().catch(() => ({}));
      const pg = ((d as any)?.data ?? []).find((p: any) => String(p.id) === PAGINAS[corpo.marca]);
      if (!pg?.access_token) return json({ erro: "não achei o token da Página de " + corpo.marca + " pelo System User: " + JSON.stringify(d).slice(0, 200) }, 500);
      urlDel = `https://graph.facebook.com/v21.0/${encodeURIComponent(corpo.mensagem_id)}?access_token=${encodeURIComponent(pg.access_token)}`;
    }

    const r = await fetch(urlDel, { method: "DELETE" });
    const rb = await r.json().catch(() => ({})) as any;
    if (!r.ok || rb?.success === false) return json({ erro: `Meta recusou (${r.status}): ${rb?.error?.message ?? JSON.stringify(rb).slice(0, 200)}` }, 502);

    const agora = new Date().toISOString();
    await admin.from("conversas").update({ apagado_em: agora }).eq("id", row.id);
    let autor = corpo.autor ?? null;
    if (!autor) {
      const { data: a } = await admin.from("conversas").select("autor").eq("autor_id", corpo.autor_id).not("autor", "is", null).limit(1);
      autor = a?.[0]?.autor ?? null;
    }
    await admin.from("conversas").insert({
      marca: corpo.marca, canal: corpo.canal, conversa_id: corpo.autor_id, autor, autor_id: corpo.autor_id,
      direcao: "saida", texto: `[respondido à mão por ${por}] comentário apagado pela tela: "${String(row.texto ?? "").slice(0, 120)}"`, categoria: "HUMANO",
    });
    return json({ ok: true, apagado_em: agora });
  } catch (e) {
    return json({ erro: "Erro: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
