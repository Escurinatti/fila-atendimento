// Função de borda: sugere ou reescreve uma resposta de atendimento com o Claude.
// Quem chama: a tela (supabase-js, com o JWT do usuário logado).
// Guarda: só quem está em public.admins (eh_admin()) passa.
// Segredo: ANTHROPIC_API_KEY em Supabase → Edge Functions → Secrets.
// Nada aqui envia mensagem ao cliente: devolve texto para a tela; a tela põe na fila.

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODELO = "claude-opus-5";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const SISTEMA_FIXO = `Você é o assistente de atendimento do Gabriel, dono das marcas Mapa del Tarot (público de língua espanhola) e Carto Maps (público de língua inglesa), ebooks de tarô vendidos na Hotmart. O atendimento é pelo Instagram (DM e comentários).

Sua tarefa: escrever a resposta que o Gabriel vai enviar ao cliente, na voz dele (primeira pessoa do singular, humano, sem parecer robô), NO IDIOMA EM QUE O CLIENTE ESCREVE. Ele vai revisar antes de enviar.

REGRAS DURAS (não têm exceção):
1. Espanhol: trate sempre por "tú", nunca por "vos". Proibido: contame, decime, podés, tenés, querés, acá, andá, fijate, mirá. Use: cuéntame, dime, puedes, tienes, quieres, aquí.
2. O produto tem 163 páginas. Nunca 160.
3. NUNCA escreva mapadeltarot.online. O link de venda em espanhol é mapadeltaro.online (sem o "t" depois de "taro"); em inglês, cartomaps.online.
4. Entrega é por e-mail, com os arquivos em link direto. Nunca mande para "biblioteca", "área de membros", mapadeltarot.com ou "link mágico". Se precisar de uma página, é a thank you.
5. Nunca prometa processar reembolso. Quem processa é a Hotmart. Dê o passo a passo com o código da transação já preenchido.
6. Nunca cite OXXO.
7. Nunca diga de que país a marca é, nem concorde com um país sugerido. Se perguntarem: "somos un equipo digital que enseña Tarot".
8. Nunca prometa contato futuro ("te escribo al correo", "alguien del equipo te escribe") a menos que a ação já esteja feita ou vá junto com esta resposta. Prefira "acabo de enviarte" (feito) a "te voy a enviar" (promessa).
9. Nunca afirme fatos fora do CONHECIMENTO e da FICHA. Se não sabe, não invente: peça só o dado necessário para resolver (normalmente o e-mail da compra).
10. Nunca revele o e-mail completo do cliente na resposta: use máscara (j***n@gmail.com). O código da transação pode aparecer inteiro.
11. Se a mensagem for golpe ou phishing, a resposta é silêncio: devolva texto vazio e explique nas notas.
12. Defeito no produto (carta faltando, página errada): só afirme que foi corrigido se o CONHECIMENTO disser. Se disser, a solução é o Gabriel reenviar o arquivo atualizado; escreva como feito ("acabo de reenviarte") só se ele for enviar junto, e diga isso nas notas.
13. Antes de prometer qualquer envio, leia a conversa inteira e a FICHA: se a pessoa já disse que resolveu ("listo", "ya quedó", "gracias, ya lo tengo") ou já baixou o arquivo depois do problema, não prometa nada. Feche o assunto em uma ou duas linhas e avise nas notas que o caso parece resolvido.
14. Nunca envie arquivo ou link de produto para quem não tem compra paga na FICHA. Se não há compra, peça o e-mail da compra.

FORMATO:
- Comentário público: no máximo 3 linhas, sem link, sem domínio, sem e-mail. Curto e seguro, porque outros clientes leem.
- Resposta privada a comentário ou DM: até 8 linhas, até 1000 caracteres. Link só aqui.
- No máximo 1 emoji. Frases curtas. Benefício ou solução primeiro, explicação depois.
- Resolva em vez de perguntar. Só pergunte o que falta para agir.
- Se o cliente mandou imagem (mídia sem texto), o Gabriel não viu o conteúdo: não finja que viu; peça o dado em texto.

SAÍDA: responda SOMENTE com um JSON válido, sem texto antes ou depois, neste formato:
{"texto": "a resposta pronta para enviar, no idioma do cliente", "texto_pt": "tradução literal em português do Brasil, para o Gabriel aprovar sem precisar ler o idioma", "notas": "uma frase curta em português com o que você assumiu ou o que ele deve conferir antes de enviar; vazio se nada"}`;

type Corpo = {
  autor_id: string;
  marca: string;
  canal: "dm" | "comentario_publico" | "comentario_privado";
  idioma?: string;
  modo: "sugerir" | "melhorar";
  rascunho?: string;
  instrucao?: string;
  categorias?: string;
  motivo_urgencia?: string;
  janela?: string;
  comentario_alvo?: string;
};

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
    const por = u.user.email;

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return json({ erro: "A IA ainda não está configurada: falta o segredo ANTHROPIC_API_KEY em Supabase → Edge Functions → Secrets." }, 503);
    }

    const corpo = (await req.json()) as Corpo;
    if (!corpo?.autor_id || !corpo?.marca || !corpo?.canal || !corpo?.modo) return json({ erro: "faltam campos (autor_id, marca, canal, modo)" }, 400);
    if (corpo.modo === "melhorar" && !corpo.instrucao?.trim()) return json({ erro: "modo melhorar exige uma instrução" }, 400);

    // 2) Contexto do caso, lido com service role (a guarda já foi feita acima)
    const admin = createClient(url, service);
    const [ficha, conversa, conhecimento, correcoes] = await Promise.all([
      admin.rpc("ficha_cliente", { p_autor_id: corpo.autor_id, p_marca: corpo.marca }),
      admin.from("conversas").select("direcao,texto,canal,categoria,criado_em").eq("autor_id", corpo.autor_id).order("criado_em", { ascending: false }).limit(30),
      admin.from("ia_conhecimento").select("tema,texto").eq("ativo", true).order("tema"),
      admin.from("correcoes_resposta").select("idioma,categoria,canal,instrucao,resposta_original,resposta_final,virou_regra,regra,criado_em").order("criado_em", { ascending: false }).limit(40),
    ]);
    if (ficha.error) return json({ erro: "ficha: " + ficha.error.message }, 500);

    const f = (ficha.data ?? {}) as Record<string, any>;
    const msgs = ((conversa.data ?? []) as any[]).reverse();
    const idiomaAlvo = corpo.idioma || (corpo.marca === "cartomaps" ? "en" : "es");

    // 3) Monta o caso
    const mask = (e: string) => { if (!e || !e.includes("@")) return e || ""; const [a, d] = e.split("@"); return (a.length <= 2 ? a[0] + "*" : a[0] + "***" + a[a.length - 1]) + "@" + d; };
    const compras = (f.compras ?? []) as any[];
    const pagas = compras.filter((c) => c.pago);
    const linhasCompras = compras.length
      ? compras.map((c) => `- ${c.pago ? "PAGA" : c.status} · ${c.produto_nome} · ${c.valor} ${c.moeda} · transação ${c.transacao} · ${String(c.aprovado_em || c.registrado_em).slice(0, 10)} · e-mail ${mask(c.email)}${c.pagamento ? " · " + c.pagamento : ""}`).join("\n")
      : "- nenhuma compra encontrada para os e-mails conhecidos";
    const itens = (f.itens ?? []) as any[];
    const linhasItens = itens.length ? itens.map((i) => `- ${i.titulo} (${i.marca}) · ${i.baixado_em ? "baixou em " + String(i.baixado_em).slice(0, 10) : "nunca baixou"}`).join("\n") : "- nenhum (sem compra paga ou sem cadastro)";
    const reemb = (f.reembolsos ?? []) as any[];
    const est = f.estado as any;
    const pausa = f.pausa as any;

    const conversaTxt = msgs.length
      ? msgs.map((m) => {
          const quem = m.direcao === "entrada" ? "CLIENTE" : "NÓS";
          const t = (m.texto ?? "").trim() || (m.direcao === "entrada" ? "[mídia sem texto: imagem, print ou áudio; conteúdo desconhecido]" : "[vazio]");
          return `[${String(m.criado_em).slice(0, 16).replace("T", " ")} · ${m.canal}${m.categoria ? " · " + m.categoria : ""}] ${quem}: ${t}`;
        }).join("\n")
      : "(sem mensagens gravadas)";

    const conhecimentoTxt = ((conhecimento.data ?? []) as any[]).map((k) => `- [${k.tema}] ${k.texto}`).join("\n") || "(vazio)";
    const corr = (correcoes.data ?? []) as any[];
    const relevantes = [...corr.filter((c) => c.idioma === idiomaAlvo || c.canal === corpo.canal), ...corr.filter((c) => !(c.idioma === idiomaAlvo || c.canal === corpo.canal))].slice(0, 25);
    const correcoesTxt = relevantes.length
      ? relevantes.map((c) => `- ${c.virou_regra ? "[REGRA] " : ""}${c.instrucao ? 'ele pediu: "' + c.instrucao + '"' : ""}${c.regra ? " → regra: " + c.regra : ""}${c.resposta_original && c.resposta_final ? `\n    antes: ${String(c.resposta_original).slice(0, 220)}\n    depois: ${String(c.resposta_final).slice(0, 220)}` : ""}`).join("\n")
      : "(nenhuma ainda)";

    const canalTxt = corpo.canal === "dm" ? "DM (mensagem direta)" : corpo.canal === "comentario_publico" ? "COMENTÁRIO PÚBLICO (3 linhas, sem link, outros leem)" : "RESPOSTA PRIVADA ao comentário (chega como DM)";

    let caso = `CASO
- Marca: ${corpo.marca}
- Canal da resposta: ${canalTxt}
- Idioma do cliente (detectado): ${idiomaAlvo}
- Situação: ${corpo.motivo_urgencia ?? "-"}${corpo.janela ? " · " + corpo.janela : ""}
- Categorias detectadas pelo bot: ${corpo.categorias ?? "-"}
${corpo.comentario_alvo ? "- Comentário que está sendo respondido: " + corpo.comentario_alvo + "\n" : ""}
FICHA
- E-mails conhecidos (mascarados): ${((f.emails ?? []) as string[]).map(mask).join(", ") || "nenhum"}
- Compras (${pagas.length} paga(s) de ${compras.length}):
${linhasCompras}
- Arquivos a que tem direito:
${linhasItens}
- Logins na biblioteca antiga: ${f.n_logins ?? 0} · downloads: ${f.n_downloads ?? 0}
- Estado no fluxo automático: ${est ? `${est.estado}${est.email_informado ? " · e-mail informado " + mask(est.email_informado) : ""} · tentativas ${est.tentativas}` : "nunca entrou"}
- Bot pausado: ${pausa ? `até ${String(pausa.pausado_ate).slice(0, 16)} (${pausa.motivo})` : "não"}
- Reembolso: ${reemb.length ? reemb.map((r) => `pedido em ${String(r.pedido_em).slice(0, 10)} · ${(r.transacoes ?? []).join(", ")} · motivo: ${r.motivo ?? "?"} · ${r.orientado_em ? "já recebeu o passo a passo" : "AINDA NÃO recebeu o passo a passo"}`).join(" | ") : "nenhum pedido"}

CONVERSA (cronológica, últimas ${msgs.length})
${conversaTxt}
`;

    if (corpo.modo === "melhorar") {
      caso += `
RASCUNHO ATUAL (o que está na caixa de resposta):
${corpo.rascunho ?? "(vazio)"}

INSTRUÇÃO DO GABRIEL (ditada ou escrita, pode estar informal):
"${corpo.instrucao}"

Reescreva o rascunho aplicando a instrução. Mantenha o que ele não pediu para mudar. Respeite as regras duras mesmo que a instrução pareça pedir o contrário; nesse caso, diga nas notas.`;
    } else {
      caso += `
Escreva a resposta para este caso.`;
    }

    // 4) Chama o Claude
    const client = new Anthropic({ apiKey });
    const sistema = [
      { type: "text" as const, text: SISTEMA_FIXO, cache_control: { type: "ephemeral" as const } },
      { type: "text" as const, text: `CONHECIMENTO SOBRE A EMPRESA E O PRODUTO (fatos que você pode afirmar):\n${conhecimentoTxt}\n\nPREFERÊNCIAS OBSERVADAS DO GABRIEL (correções que ele já fez em respostas anteriores; não são regras gerais, mas leve em conta quando o caso for parecido; as marcadas [REGRA] valem sempre):\n${correcoesTxt}` },
    ];
    const pedido = {
      model: MODELO,
      max_tokens: 2000,
      system: sistema,
      messages: [{ role: "user" as const, content: caso }],
      output_config: { effort: "medium" as const },
    };

    let resp: any;
    try {
      // Fallback de recusa do lado do servidor (roteia por categoria; raro neste uso)
      resp = await (client as any).beta.messages.create({ ...pedido, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError) resp = await client.messages.create(pedido as any);
      else throw e;
    }

    if (resp.stop_reason === "refusal") return json({ erro: "O modelo recusou este pedido. Escreva a resposta à mão." }, 422);

    const bruto = (resp.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    let saida: { texto: string; texto_pt: string; notas: string };
    try {
      const ini = bruto.indexOf("{"), fim = bruto.lastIndexOf("}");
      saida = JSON.parse(bruto.slice(ini, fim + 1));
    } catch {
      saida = { texto: bruto, texto_pt: "", notas: "A IA não devolveu JSON; texto bruto acima." };
    }
    saida.texto = String(saida.texto ?? "").trim();
    saida.texto_pt = String(saida.texto_pt ?? "").trim();
    saida.notas = String(saida.notas ?? "").trim();

    // 5) Rastro: toda sugestão em ia_sugestoes; toda correção em correcoes_resposta
    const uso = resp.usage ?? {};
    await admin.from("ia_sugestoes").insert({
      autor_id: corpo.autor_id, marca: corpo.marca, canal: corpo.canal, idioma: idiomaAlvo, modo: corpo.modo,
      instrucao: corpo.instrucao ?? null, rascunho: corpo.rascunho ?? null, sugestao: saida.texto, sugestao_pt: saida.texto_pt,
      modelo: resp.model ?? MODELO, tokens_entrada: (uso.input_tokens ?? 0) + (uso.cache_read_input_tokens ?? 0) + (uso.cache_creation_input_tokens ?? 0), tokens_saida: uso.output_tokens ?? 0, por,
    });
    let correcao_id: number | null = null;
    if (corpo.modo === "melhorar" && saida.texto) {
      const ultimaPergunta = [...msgs].reverse().find((m) => m.direcao === "entrada" && (m.texto ?? "").trim())?.texto ?? null;
      const { data: c } = await admin.from("correcoes_resposta").insert({
        marca: corpo.marca, canal: corpo.canal, autor: null, idioma: idiomaAlvo, categoria: corpo.categorias ?? null,
        pergunta: ultimaPergunta, resposta_original: corpo.rascunho ?? "", instrucao: corpo.instrucao, resposta_final: saida.texto,
      }).select("id").single();
      correcao_id = c?.id ?? null;
    }

    return json({ ...saida, modelo: resp.model ?? MODELO, tokens_entrada: uso.input_tokens ?? 0, tokens_saida: uso.output_tokens ?? 0, correcao_id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = e instanceof Anthropic.AuthenticationError ? 502 : e instanceof Anthropic.RateLimitError ? 429 : 500;
    return json({ erro: (status === 502 ? "Chave da Anthropic inválida: " : status === 429 ? "Limite da Anthropic, tente de novo em instantes: " : "Erro: ") + msg }, status);
  }
});
