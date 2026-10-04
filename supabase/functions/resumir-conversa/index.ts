// Função de borda: resume a conversa inteira de um cliente em português, para a tela.
// Guarda em conversa_resumos e só chama a IA de novo quando chegou mensagem nova.
// Quem chama: a tela (JWT do admin). Segredo: ANTHROPIC_API_KEY.

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODELO = "claude-haiku-4-5";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const SISTEMA = `Você resume conversas de atendimento (Instagram/Facebook) de uma marca que vende um ebook de tarô pela Hotmart. Quem lê é o Gabriel, o dono, em português do Brasil, no celular, com pressa.

Regras:
- Máximo 5 linhas curtas, sem título, sem markdown, sem emoji. Cada linha começa com "• ".
- Ordem: (1) quem é e o que comprou/quer; (2) qual é o problema ou pedido; (3) o que o bot/nós já dissemos ou fizemos, incluindo promessas feitas; (4) o que ainda está em aberto; (5) risco (reembolso, briga, golpe, comentário público) se houver.
- Se o bot prometeu algo que não fez ("te reenvío", "you'll have it within the hour"), diga isso com todas as letras: é o mais importante para o Gabriel.
- Datas: use dd/mm hh:mm quando importar.
- Nunca invente. Se a conversa é curta ou só elogio, diga em 1 linha.

SAÍDA: responda SOMENTE com JSON válido: {"resumo": "as linhas com \\n", "quer": "em até 8 palavras o que a pessoa quer", "proximo_passo": "em até 12 palavras o que o Gabriel deve fazer agora, ou 'nada' se resolvido"}`;

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

    const corpo = await req.json() as { autor_id: string; marca: string; forcar?: boolean };
    if (!corpo?.autor_id || !corpo?.marca) return json({ erro: "faltam autor_id e marca" }, 400);

    const admin = createClient(url, service);
    const { data: msgs, error: merr } = await admin.from("conversas")
      .select("direcao,canal,texto,texto_pt,categoria,criado_em,apagado_em,oculto_em")
      .eq("autor_id", corpo.autor_id).order("criado_em", { ascending: false }).limit(80);
    if (merr) return json({ erro: "banco: " + merr.message }, 500);
    const lista = (msgs ?? []).reverse();
    if (!lista.length) return json({ resumo: "Sem mensagens gravadas.", quer: "", proximo_passo: "", cache: true });
    const ultima = lista[lista.length - 1].criado_em;

    const { data: cache } = await admin.from("conversa_resumos").select("*").eq("autor_id", corpo.autor_id).eq("marca", corpo.marca).maybeSingle();
    if (cache && !corpo.forcar && new Date(cache.resumo_ate) >= new Date(ultima)) {
      return json({ resumo: cache.resumo, quer: cache.quer, proximo_passo: cache.proximo_passo, atualizado_em: cache.atualizado_em, n_msgs: cache.n_msgs, cache: true });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ erro: "falta ANTHROPIC_API_KEY" }, 503);

    // ficha resumida: compras e envios, para o resumo dizer se já foi entregue
    const { data: ficha } = await admin.rpc("ficha_cliente", { p_autor_id: corpo.autor_id, p_marca: corpo.marca });
    const f = (ficha ?? {}) as Record<string, any>;
    const compras = ((f.compras ?? []) as any[]).map((c) => `${c.pago ? "PAGA" : c.status} ${c.produto_nome} ${String(c.aprovado_em || c.registrado_em).slice(0, 10)} ${c.transacao}`).join("; ") || "nenhuma compra encontrada";
    const envios = ((f.envios ?? []) as any[]).map((e) => `${String(e.criado_em).slice(0, 16).replace("T", " ")} para ${e.para} (${(e.arquivos || []).length} arq, ${e.resultado})`).join("; ") || "nenhum e-mail com arquivos enviado por nós";
    const est = f.estado ? `${f.estado.estado}${f.estado.email_informado ? " · e-mail " + f.estado.email_informado : ""}` : "nunca entrou no fluxo de acesso";

    const conversa = lista.map((m) => {
      const quem = m.direcao === "entrada" ? "CLIENTE" : (String(m.texto || "").startsWith("[") ? "REGISTRO INTERNO" : "NÓS");
      const t = (m.texto || "").trim() || "[mídia sem texto]";
      const extra = m.apagado_em ? " (comentário apagado)" : m.oculto_em ? " (comentário oculto)" : "";
      return `[${String(m.criado_em).slice(5, 16).replace("T", " ")} ${m.canal}${m.categoria ? " " + m.categoria : ""}] ${quem}: ${t}${extra}`;
    }).join("\n");

    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: MODELO, max_tokens: 600,
      system: SISTEMA,
      messages: [{ role: "user", content: `MARCA: ${corpo.marca}\nCOMPRAS: ${compras}\nE-MAILS COM ARQUIVOS: ${envios}\nESTADO NO FLUXO: ${est}\n\nCONVERSA (cronológica, ${lista.length} mensagens):\n${conversa}` }],
    });
    const bruto = (resp.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    let saida: any;
    try { const i = bruto.indexOf("{"), fim = bruto.lastIndexOf("}"); saida = JSON.parse(bruto.slice(i, fim + 1)); }
    catch { saida = { resumo: bruto, quer: "", proximo_passo: "" }; }
    const resumo = String(saida.resumo ?? "").trim(), quer = String(saida.quer ?? "").trim(), proximo = String(saida.proximo_passo ?? "").trim();

    await admin.from("conversa_resumos").upsert({
      autor_id: corpo.autor_id, marca: corpo.marca, resumo, quer, proximo_passo: proximo,
      resumo_ate: ultima, n_msgs: lista.length, modelo: resp.model ?? MODELO, atualizado_em: new Date().toISOString(),
    });
    return json({ resumo, quer, proximo_passo: proximo, atualizado_em: new Date().toISOString(), n_msgs: lista.length, cache: false });
  } catch (e) {
    return json({ erro: "Erro: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
