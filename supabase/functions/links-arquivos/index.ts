// Função de borda: gera links assinados (30 dias) dos arquivos a que um cliente tem direito.
// Quem chama: a tela, para mandar os arquivos por DM / resposta privada.
// Trava: só devolve links se a ficha tiver compra PAGA, ou se o admin confirmar à mão
// (p_confirmo = true + justificativa), e nesse caso fica registrado em verificacoes_compra.
// Nada aqui envia mensagem: devolve os links; a tela põe o texto na fila e o n8n envia.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const VALIDADE_SEG = 60 * 60 * 24 * 30; // 30 dias

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

    const corpo = await req.json() as { autor_id: string; marca: string; itens_ids?: number[]; confirmo?: boolean; justificativa?: string };
    if (!corpo?.autor_id || !corpo?.marca) return json({ erro: "faltam autor_id e marca" }, 400);

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
        return json({ erro: "Sem compra paga na ficha. Para mandar arquivos mesmo assim, confirme à mão e escreva por que tem certeza (fica registrado).", precisa_confirmacao: true }, 409);
      }
      // Confirmação manual: registra e libera os itens principais da marca (edição completa)
      const { data: it } = await admin.from("itens_membros").select("id,marca,titulo,bucket,arquivo,produto_id,secao,ordem").eq("ativo", true).eq("marca", corpo.marca).eq("secao", "principal").order("ordem");
      itens = it ?? [];
      base = "confirmacao_manual";
      await admin.from("verificacoes_compra").insert({
        marca: corpo.marca, conversa_id: corpo.autor_id, autor: null,
        email_consultado: ((f.emails ?? []) as string[])[0] ?? "(sem e-mail)",
        origem: "tela", resultado: "confianca_manual", qtd_encontrada: 0,
        acao_tomada: "links de arquivos liberados por confirmação manual: " + corpo.justificativa!.trim(),
        decidido_por: por, aprovado: true,
      });
    }

    if (corpo.itens_ids?.length) {
      const set = new Set(corpo.itens_ids.map(Number));
      // itens da ficha não trazem id; casa por arquivo quando vier da confirmação manual, senão por índice
      itens = itens.filter((i, idx) => set.has(Number(i.id ?? idx)));
    }
    if (!itens.length) return json({ erro: "Nenhum arquivo para gerar link." }, 404);

    const links: { titulo: string; url: string; bucket: string; arquivo: string }[] = [];
    const falhas: string[] = [];
    for (const i of itens) {
      const { data, error } = await admin.storage.from(i.bucket).createSignedUrl(i.arquivo, VALIDADE_SEG);
      if (error || !data?.signedUrl) { falhas.push(`${i.titulo}: ${error?.message ?? "sem url"}`); continue; }
      links.push({ titulo: i.titulo, url: data.signedUrl, bucket: i.bucket, arquivo: i.arquivo });
    }
    return json({ base, por, validade_dias: 30, links, falhas });
  } catch (e) {
    return json({ erro: "Erro: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
