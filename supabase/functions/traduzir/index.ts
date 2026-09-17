// Função de borda: traduz para português o que o CLIENTE escreveu.
// Quem chama: a tela (supabase-js, com o JWT do usuário logado).
// Guarda: só quem está em public.admins (eh_admin()) passa.
// Segredo: ANTHROPIC_API_KEY em Supabase → Edge Functions → Secrets (o mesmo da sugerir-resposta).
//
// Recebe ids de linhas de public.conversas (só entradas), traduz o campo texto,
// grava em conversas.texto_pt e devolve { traducoes: { id: pt } }.
// Cada mensagem é traduzida UMA vez: quem já tem texto_pt não volta para a IA.
// Modelo: Haiku 4.5 — tradução é tarefa simples; sai ~10x mais barato que o Opus.

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODELO = "claude-haiku-4-5-20251001";
const MAX_IDS = 40;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const SISTEMA = `Você traduz mensagens de clientes para o português do Brasil, para o dono da marca entender o que a pessoa disse sem saber o idioma dela.

Regras:
- Traduza fielmente. Não resuma, não explique, não responda à pessoa, não "melhore" o texto.
- Mantenha o tom: se a pessoa está irritada, a tradução tem que soar irritada; se é gíria, use gíria equivalente.
- Erros de digitação e abreviações: traduza o sentido, não o erro.
- E-mails, códigos (HP...), links, nomes de produto e @usuários: copie exatamente como estão.
- Emojis: mantenha.
- Se a mensagem já está em português, devolva ela igual.
- Se o texto for só emoji, link ou código sem palavras, devolva ele igual.
- Devolva SOMENTE um JSON, sem texto antes ou depois, no formato:
  {"traducoes":[{"id":123,"pt":"..."},{"id":124,"pt":"..."}]}`;

type Linha = { id: number; texto: string | null; direcao: string; texto_pt: string | null };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "use POST" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const auth = req.headers.get("Authorization") ?? "";

    // 1) Quem está chamando, e é admin?
    const comoUsuario = createClient(url, anon, { global: { headers: { Authorization: auth } } });
    const { data: u, error: uerr } = await comoUsuario.auth.getUser();
    if (uerr || !u?.user?.email) return json({ erro: "não logado" }, 401);
    const { data: ehAdmin } = await comoUsuario.rpc("eh_admin");
    if (!ehAdmin) return json({ erro: "sem permissão" }, 403);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ erro: "falta o segredo ANTHROPIC_API_KEY em Supabase → Edge Functions → Secrets." }, 503);

    // 2) Entrada
    const corpo = (await req.json()) as { ids?: unknown };
    const ids = Array.isArray(corpo?.ids)
      ? [...new Set(corpo.ids.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_IDS)
      : [];
    if (!ids.length) return json({ erro: "mande ids (números) de public.conversas" }, 400);

    // 3) Lê as linhas com service role (a guarda já foi feita acima)
    const admin = createClient(url, service);
    const { data: linhas, error: lerr } = await admin
      .from("conversas")
      .select("id,texto,direcao,texto_pt")
      .in("id", ids);
    if (lerr) return json({ erro: "conversas: " + lerr.message }, 500);

    const todas = (linhas ?? []) as Linha[];
    const traducoes: Record<number, string> = {};
    // o que já tem tradução volta direto, sem custo
    for (const l of todas) if (l.texto_pt) traducoes[l.id] = l.texto_pt;

    const pendentes = todas.filter((l) => !l.texto_pt && l.direcao === "entrada" && l.texto && l.texto.trim());
    if (!pendentes.length) return json({ traducoes, novas: 0, modelo: null });

    // 4) Traduz em lote
    const entrada = pendentes.map((l) => ({ id: l.id, texto: String(l.texto).slice(0, 2000) }));
    const anthropic = new Anthropic({ apiKey });
    const resp = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 4000,
      system: SISTEMA,
      messages: [{ role: "user", content: "MENSAGENS:\n" + JSON.stringify(entrada) }],
    });
    const bruto = resp.content.map((c) => ("text" in c ? c.text : "")).join("").trim();
    const m = bruto.match(/\{[\s\S]*\}/);
    let saida: { traducoes?: { id: number; pt: string }[] } = {};
    try { saida = JSON.parse(m ? m[0] : bruto); } catch { return json({ erro: "a IA devolveu algo que não é JSON", bruto: bruto.slice(0, 300) }, 502); }

    // 5) Grava uma a uma (só ids que pedimos, só texto não vazio)
    const permitidos = new Set(pendentes.map((l) => l.id));
    let novas = 0;
    for (const t of saida.traducoes ?? []) {
      const id = Number(t?.id); const pt = String(t?.pt ?? "").trim();
      if (!permitidos.has(id) || !pt) continue;
      const { error } = await admin.from("conversas").update({ texto_pt: pt }).eq("id", id);
      if (!error) { traducoes[id] = pt; novas++; }
    }

    const uso = resp.usage ?? ({} as { input_tokens?: number; output_tokens?: number });
    return json({ traducoes, novas, modelo: resp.model ?? MODELO, tokens_entrada: uso.input_tokens ?? 0, tokens_saida: uso.output_tokens ?? 0 });
  } catch (e) {
    return json({ erro: String((e as Error)?.message ?? e).slice(0, 300) }, 500);
  }
});
