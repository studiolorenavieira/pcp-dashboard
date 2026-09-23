// shared.js — utilitários comuns às 4 telas do PCP Dashboard
// (cliente da API, formatação, normalização de dados DAPIC, sidebar, tabelas ordenáveis)

const API_BASE = "https://lrtphrdqyeoblbwwnujv.supabase.co/functions/v1/pcp-dapic";
const SUPABASE_ANON_KEY = "sb_publishable_3uUw6iqFiXqBwnU5Kj5k7Q_PEMLUHEe";
/* =========================================================================
   NOTA SOBRE OS NOMES DE CAMPO DA DAPIC
   -------------------------------------------------------------------------
   A documentação pública da DAPIC não especifica os nomes exatos dos campos
   de cada registro. Para não travar o dashboard nisso, toda leitura de campo
   passa por getField(obj, [lista de nomes candidatos]) — que tenta várias
   variações (PascalCase, camelCase, com/sem acento) até achar uma.
   Se algum painel aparecer vazio ou com "—", abra o Console do navegador:
   cada carregamento loga uma amostra do primeiro registro cru de cada
   endpoint (console.table), o que facilita achar o nome real do campo e
   adicioná-lo em FIELD_ALIASES abaixo.
   ========================================================================= */

function getField(obj, candidates) {
  if (!obj || typeof obj !== "object") return undefined;
  const keys = Object.keys(obj);
  // Um candidato PRESENTE mas null (ex: "DataFechamento" numa venda ainda
  // aberta) não conta como achado — senão a busca para aí e nunca tenta o
  // próximo candidato da lista, mesmo que ele tenha um valor real.
  for (const candidate of candidates) {
    if (obj[candidate] !== undefined && obj[candidate] !== null) return obj[candidate];
  }
  const lowerMap = {};
  keys.forEach((k) => (lowerMap[k.toLowerCase()] = k));
  for (const candidate of candidates) {
    const hit = lowerMap[candidate.toLowerCase()];
    if (hit !== undefined && obj[hit] !== undefined && obj[hit] !== null) return obj[hit];
  }
  return undefined;
}

const FIELD_ALIASES = {
  produtoRef: ["Referencia", "ReferenciaProduto", "Codigo", "CodigoProduto", "Sku", "SKU", "RefProduto"],
  produtoNome: ["Nome", "NomeProduto", "Descricao", "DescricaoProduto", "Produto"],
  quantidade: ["Quantidade", "Qtd", "QtdVendida", "QtdEstoque", "Saldo", "SaldoEstoque", "QuantidadeTotal", "QuantidadeFinalizada"],
  valorTotal: ["ValorTotal", "ValorLiquido", "ValorItem", "Total", "ValorVenda", "ValorFaturado"],
  // "DataFechamento" (data em que a venda foi fechada) é o campo real usado
  // por v1/vendaspdv — vem null enquanto a venda está "Aberta"/"Cancelada",
  // então "DataModificacao" cobre esses casos como 2ª opção. Achado
  // inspecionando o retorno cru (22/09/2026) — antes disso a lista de
  // candidatos não tinha nenhum desses dois nomes, e todo item de venda
  // ficava sem data, quebrando "idade do estoque" e "última venda" pra todo
  // produto do dashboard.
  data: ["DataFechamento", "DataModificacao", "DataVenda", "Data", "DataEmissao", "DataPedido", "DataFatura", "DataMovimentacao"],
  itensArray: ["Itens", "ItensVenda", "ItensPedido", "Produtos", "ItensFatura"],
  tipoOrdem: ["Tipo", "TipoOrdem", "Categoria"],
  status: ["Status", "Situacao", "StatusOrdem"],
  dataPrevisao: ["DataPrevisao", "DataPrevisaoEntrega", "DataEntrega", "DataPrevista"],
  dataConclusao: ["DataConclusao", "DataFinalizacao", "DataEncerramento"],
  dataEntradaEstoque: ["DataUltimaEntrada", "DataEntrada", "DataUltimaMovimentacao", "DataCompra", "DataCadastro"],
  produtoCusto: ["Custo", "ValorCusto", "PrecoCusto", "CustoMedio"],
  produtoPreco: ["PrecoVenda", "ValorVenda", "Preco", "PrecoTabela"],
  ordemRef: ["OrdemProducao", "NumeroOrdem", "Ordem"],
  itemCor: ["Cor"],
  itemTamanho: ["Tamanho"],
  itemColecao: ["Colecao"],
  // Grade da produção (v1/ordensproducao/produtos) — usado para cruzar
  // produzido x estoque atual pela MESMA grade que a DAPIC usa em
  // v1/produtos/{id} -> GradesProdutos -> Id (== idGrade em estoque-lote).
  itemIdGrade: ["IdGradeProduto", "IdGrade"],
  itemDataFinalizacao: ["DataFinalizacaoProducao", "DataFinalizacao", "DataConclusao"],
  // Tipo do item dentro de uma venda (v1/vendaspdv -> Produtos[].Tipo):
  // "Venda" | "Devolução" | "Brinde". Achado em 23/09/2026 ao investigar o
  // Vestido Marine: a DAPIC devolve os 3 tipos com quantidade/valor SEMPRE
  // positivos (mesmo sinal de uma venda normal) — quem decide se é
  // entrada/saída/sem-receita é esse campo, não o sinal do valor. Usado por
  // flattenVendas() para não contar Devolução e Brinde como venda normal.
  itemTipoVenda: ["Tipo"],
};

function f(obj, key) {
  return getField(obj, FIELD_ALIASES[key] || [key]);
}

/* ---------------------------- API client -------------------------------- */

async function apiGet(endpoint, params = {}) {
  const url = new URL(API_BASE, window.location.origin);
  url.searchParams.set("endpoint", endpoint);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.erro || `Erro ao consultar ${endpoint} (HTTP ${res.status})`);
  }
  if (json.dados && json.dados.length) {
    console.groupCollapsed(`[DAPIC] ${endpoint} — ${json.dados.length} registro(s) (amostra)`);
    console.table([json.dados[0]]);
    console.groupEnd();
  }
  return json.dados || [];
}

// A DAPIC não tem endpoint de listagem de estoque — o saldo por grade só vem
// no detalhe de cada produto (v1/produtos/{id}), e o catálogo tem ~550 itens
// ativos. Por isso buscamos em lotes (endpoint=estoque-lote), com o servidor
// paralelizando os detalhes de cada lote. onProgress(carregados, total) é
// opcional, para mostrar uma barra de progresso.
async function fetchEstoqueCompleto(onProgress) {
  let offset = 0;
  let total = null;
  const produtos = [];
  do {
    const json = await apiGetRaw("estoque-lote", { offset, limite: 100 });
    produtos.push(...(json.produtos || []));
    total = json.totalProdutos ?? produtos.length;
    offset = json.proximoOffset;
    if (onProgress) onProgress(produtos.length, total);
  } while (offset !== null && offset !== undefined);
  return produtos;
}

// Como apiGet() extrai `json.dados`, usamos apiGetRaw p/ endpoints compostos
// (como estoque-lote) que devolvem um formato próprio, não {dados: [...]}.
async function apiGetRaw(endpoint, params = {}) {
  const url = new URL(API_BASE, window.location.origin);
  url.searchParams.set("endpoint", endpoint);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.erro || `Erro ao consultar ${endpoint} (HTTP ${res.status})`);
  }
  return json;
}

// Converte a lista de produtos-com-grades (de fetchEstoqueCompleto) para o
// mesmo formato de mapa ref -> {ref, nome, quantidade, dataEntrada} usado
// pelo resto do dashboard. Não há data de entrada por grade na DAPIC, então
// dataEntrada fica null aqui de propósito — a "idade" do estoque parado é
// calculada a partir da última venda (ver aggregateVendasPorProduto).
function estoqueLoteParaMapa(produtosComGrades) {
  const map = new Map();
  for (const p of produtosComGrades) {
    const ref = String(p.referencia ?? "—");
    map.set(ref, {
      ref,
      nome: p.nome || "Produto sem nome",
      quantidade: p.estoqueTotal || 0,
      dataEntrada: null,
      // Custo/preço unitário (achado em v1/produtos/{id} -> GradesProdutos ->
      // ValorCusto/ValorVenda; a listagem v1/produtos não traz esses campos).
      // Ficam 0 até o cache de estoque desse produto atualizar (TTL 1h).
      custo: p.custo || 0,
      preco: p.preco || 0,
    });
  }
  return map;
}

function dateRangeParams(days) {
  const hoje = new Date();
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - Number(days));
  return {
    DataInicial: isoDate(inicio),
    DataFinal: isoDate(hoje),
  };
}

/* ---------------------------- Formatação --------------------------------- */

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function parseAnyDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysAgo(date) {
  if (!date) return null;
  const ms = Date.now() - date.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function fmtBRL(v) {
  const n = Number(v) || 0;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
}

function fmtBRLCents(v) {
  const n = Number(v) || 0;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtInt(v) {
  return Math.round(Number(v) || 0).toLocaleString("pt-BR");
}

function fmtPct(v, digits = 0) {
  const n = Number(v) || 0;
  return n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits }) + "%";
}

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  const nomes = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  return `${nomes[m - 1]}/${String(y).slice(2)}`;
}

/* ------------------------- Classificação (cores) -------------------------- */

function stClass(pct) {
  if (pct >= 70) return "good";
  if (pct >= 40) return "warn";
  return "danger";
}

function ageClass(days) {
  if (days === null) return "neutral";
  if (days > 90) return "danger";
  if (days > 60) return "warn";
  return "good";
}

/* ------------------------- Normalização de vendas -------------------------- */
// Aceita registros "flat" (uma linha = um item vendido) ou registros com
// header + array de itens aninhado, e sempre devolve uma lista plana de
// { ref, nome, quantidade, valorTotal, data }.

// Classifica o campo Tipo de um item de venda (ver FIELD_ALIASES.itemTipoVenda)
// em "venda" | "devolucao" | "brinde" | "outro". Comparação sem acento/caixa
// porque já vimos a DAPIC variar (ex.: "Devolução" vs "devolucao").
function classificarTipoItemVenda(tipoRaw) {
  const t = String(tipoRaw || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  if (t.includes("devolu")) return "devolucao";
  if (t.includes("brinde")) return "brinde";
  if (t.includes("venda") || t === "") return "venda";
  return "outro";
}

// Classifica o campo Tipo de um item de consignado (v1/consignados ->
// Produtos[].Tipo) em "remessa" | "retorno" | "venda" | "outro".
function classificarTipoItemConsignado(tipoRaw) {
  const t = String(tipoRaw || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
  if (t.includes("remessa")) return "remessa";
  if (t.includes("retorno")) return "retorno";
  if (t.includes("venda")) return "venda";
  return "outro";
}

// Busca todos os documentos de consignado num intervalo de datas. A própria
// function no Supabase já pagina TODAS as páginas da DAPIC internamente numa
// única chamada (ver comentário no topo do index.ts) — passar Pagina/
// RegistrosPorPagina aqui faria a function refazer a busca completa a cada
// chamada nossa, só desperdiçando tempo e cota de requisições.
async function fetchConsignadosCompleto(periodo) {
  return apiGet("v1/consignados", periodo);
}

// Consignado: saldo ainda "fora" (não retornado, e não vendido dentro do
// próprio consignado) por produto — Remessa menos Retorno menos Venda,
// somado por documento e depois por referência de produto. Confirmado
// batendo exato com a coluna "Consignado Remessa" do relatório oficial
// "Histórico de produto acabado" da DAPIC (Vestido Junia, 23/09/2026: 9
// peças líquidas de 11 remessas brutas — as 2 restantes já têm um item
// Tipo=Venda dentro do MESMO documento, ou seja, já viraram venda formal
// dentro do próprio consignado) — sem precisar cruzar com vendaspdv.
// Por decisão do Marcelo (23/09/2026): esse saldo conta como "vendido" no
// dashboard até retornar de fato — quando isso acontecer, a próxima
// atualização já reflete (a peça sai do saldo pendente automaticamente).
function aggregateConsignadoPendentePorProduto(registrosConsignados) {
  const map = new Map(); // ref -> { ref, nome, quantidade, valorTotal }
  for (const doc of registrosConsignados) {
    const itens = f(doc, "itensArray") || [];
    for (const item of itens) {
      const tipo = classificarTipoItemConsignado(f(item, "itemTipoVenda"));
      if (tipo === "outro") continue;
      const ref = String(f(item, "produtoRef") ?? "—");
      const qtd = Number(f(item, "quantidade")) || 0;
      const valor = Number(f(item, "valorTotal")) || 0;
      const sinal = tipo === "remessa" ? 1 : -1; // retorno e venda (dentro do consignado) resolvem a remessa.
      if (!map.has(ref)) {
        map.set(ref, { ref, nome: f(item, "produtoNome") || "Produto sem nome", quantidade: 0, valorTotal: 0 });
      }
      const agg = map.get(ref);
      agg.quantidade += sinal * qtd;
      agg.valorTotal += sinal * valor;
    }
  }
  // Nunca negativo por produto (retorno/venda não deveria superar a remessa,
  // mas por segurança não deixamos isso diminuir o "vendido").
  for (const agg of map.values()) {
    if (agg.quantidade < 0) agg.quantidade = 0;
    if (agg.valorTotal < 0) agg.valorTotal = 0;
  }
  return map;
}

// Soma o saldo pendente de consignado (aggregateConsignadoPendentePorProduto)
// dentro de um mapa de vendas (aggregateVendasPorProduto) — ver nota acima.
// Modifica e devolve o próprio mapa de vendas.
function mesclarConsignadoPendente(vendasPorProdutoMap, consignadoPendenteMap) {
  for (const [ref, pend] of consignadoPendenteMap) {
    if (pend.quantidade <= 0) continue;
    if (!vendasPorProdutoMap.has(ref)) {
      vendasPorProdutoMap.set(ref, { ref, nome: pend.nome, quantidade: 0, valorTotal: 0, ultimaVenda: null });
    }
    const agg = vendasPorProdutoMap.get(ref);
    agg.quantidade += pend.quantidade;
    agg.valorTotal += pend.valorTotal;
    if (!agg.nome || agg.nome === "Produto sem nome") agg.nome = pend.nome;
  }
  return vendasPorProdutoMap;
}

function flattenVendas(registros) {
  const linhas = [];
  for (const reg of registros) {
    const itensArr = f(reg, "itensArray");
    const data = parseAnyDate(f(reg, "data"));
    if (Array.isArray(itensArr) && itensArr.length) {
      for (const item of itensArr) {
        // A DAPIC manda Devolução/Brinde com quantidade e valor sempre
        // POSITIVOS (mesmo sinal de uma venda normal) — só o campo Tipo
        // diferencia. Sem este tratamento, devolução e brinde eram somados
        // como se fossem venda normal, inflando quantidade vendida,
        // faturamento e ticket médio no painel inteiro.
        const tipo = classificarTipoItemVenda(f(item, "itemTipoVenda"));
        if (tipo === "brinde") continue; // não é venda: mercadoria dada, sem receita — não entra na contagem.
        const sinal = tipo === "devolucao" ? -1 : 1; // devolução desconta da venda líquida (voltou pro estoque).
        linhas.push({
          ref: String(f(item, "produtoRef") ?? f(reg, "produtoRef") ?? "—"),
          nome: f(item, "produtoNome") ?? f(reg, "produtoNome") ?? "Produto sem nome",
          quantidade: sinal * (Number(f(item, "quantidade")) || 0),
          valorTotal: sinal * (Number(f(item, "valorTotal")) || 0),
          data,
        });
      }
    } else {
      linhas.push({
        ref: String(f(reg, "produtoRef") ?? "—"),
        nome: f(reg, "produtoNome") ?? "Produto sem nome",
        quantidade: Number(f(reg, "quantidade")) || 0,
        valorTotal: Number(f(reg, "valorTotal")) || 0,
        data,
      });
    }
  }
  return linhas;
}

function normalizeEstoque(registros) {
  return registros.map((reg) => ({
    ref: String(f(reg, "produtoRef") ?? "—"),
    nome: f(reg, "produtoNome") ?? "Produto sem nome",
    quantidade: Number(f(reg, "quantidade")) || 0,
    dataEntrada: parseAnyDate(f(reg, "dataEntradaEstoque")),
  }));
}

function buildProdutoCatalog(registros) {
  const map = new Map();
  for (const reg of registros) {
    const ref = String(f(reg, "produtoRef") ?? "—");
    map.set(ref, {
      ref,
      nome: f(reg, "produtoNome") ?? "Produto sem nome",
      custo: Number(f(reg, "produtoCusto")) || 0,
      preco: Number(f(reg, "produtoPreco")) || 0,
    });
  }
  return map;
}

// Agrega linhas de venda (já "achatadas" por flattenVendas) por referência de produto.
function aggregateVendasPorProduto(linhas) {
  const map = new Map();
  for (const l of linhas) {
    if (!map.has(l.ref)) map.set(l.ref, { ref: l.ref, nome: l.nome, quantidade: 0, valorTotal: 0, ultimaVenda: null });
    const agg = map.get(l.ref);
    agg.quantidade += l.quantidade;
    agg.valorTotal += l.valorTotal;
    if (l.nome && l.nome !== "Produto sem nome") agg.nome = l.nome;
    if (l.data && (!agg.ultimaVenda || l.data > agg.ultimaVenda)) agg.ultimaVenda = l.data;
  }
  return map;
}

// Agrega estoque por referência (soma quantidade, guarda a data de entrada mais antiga
// como proxy de "desde quando essa posição está parada").
function aggregateEstoquePorProduto(estoqueNorm) {
  const map = new Map();
  for (const e of estoqueNorm) {
    if (!map.has(e.ref)) map.set(e.ref, { ref: e.ref, nome: e.nome, quantidade: 0, dataEntrada: e.dataEntrada });
    const agg = map.get(e.ref);
    agg.quantidade += e.quantidade;
    if (e.nome && e.nome !== "Produto sem nome") agg.nome = e.nome;
    if (e.dataEntrada && (!agg.dataEntrada || e.dataEntrada < agg.dataEntrada)) {
      agg.dataEntrada = e.dataEntrada;
    }
  }
  return map;
}

// NOTA: v1/ordensproducao (listagem/detalhe da ordem) nunca traz nome/SKU do
// produto — a "Referencia" da ordem e um numero de documento (ex:
// 250424140115NL), nao o codigo do produto no catalogo. Por isso `nome` fica
// null aqui de proposito. O nome real vem de um endpoint separado, nao
// documentado publicamente pela DAPIC (achado em ajuda.dapic.com.br):
// v1/ordensproducao/produtos, que traz uma linha por ordem+produto+grade.
// Ver groupProdutosPorOrdem() logo abaixo — a tela de Producao busca os dois
// endpoints e junta pelo numero da ordem (ref <-> OrdemProducao).
//
// NOTA sobre "tipo" (CÁPSULA vs REPOSIÇÃO): removido em 22/09/2026. O campo
// "Tipo" da DAPIC em v1/ordensproducao é uma classificação de produto
// ("Produto Acabado" em 100% das ordens testadas), não uma classificação de
// negócio cápsula/reposição — checamos também Observacao e ReferenciaExterna
// (ambos sempre vazios) e todo o retorno de v1/ordensproducao/produtos
// (Colecao, Grupo, Marca, Referencia do produto): nenhum campo da DAPIC
// distingue cápsula de reposição. Por isso o badge foi trocado pela Coleção
// real (ex: "Agosto/2026"), que vem de v1/ordensproducao/produtos.
function normalizeOrdens(registros) {
  return registros.map((reg) => ({
    ref: String(f(reg, "produtoRef") ?? "—"),
    nome: f(reg, "produtoNome") ?? null,
    quantidade: Number(f(reg, "quantidade")) || 0,
    status: (f(reg, "status") || "").toString(),
    dataPrevisao: parseAnyDate(f(reg, "dataPrevisao")),
    dataConclusao: parseAnyDate(f(reg, "dataConclusao")),
  }));
}

// Agrupa as linhas de v1/ordensproducao/produtos (uma por ordem+produto+
// grade) pelo número da ordem, para anexar nome/cor/tamanho/quantidade/coleção
// de produto a cada ordem de v1/ordensproducao (que sozinha não traz essa
// info). Devolve um Map: ref da ordem -> [{ nome, cor, tamanho, quantidade, colecao }].
function groupProdutosPorOrdem(registros) {
  const map = new Map();
  for (const reg of registros) {
    const ordemRef = String(f(reg, "ordemRef") ?? "").trim();
    if (!ordemRef) continue;
    if (!map.has(ordemRef)) map.set(ordemRef, []);
    map.get(ordemRef).push({
      nome: f(reg, "produtoNome") ?? "Produto sem nome",
      cor: (f(reg, "itemCor") ?? "").toString(),
      tamanho: (f(reg, "itemTamanho") ?? "").toString(),
      quantidade: Number(f(reg, "quantidade")) || 0,
      colecao: (f(reg, "itemColecao") ?? "").toString(),
    });
  }
  return map;
}

// Agrega as mesmas linhas de v1/ordensproducao/produtos, mas por GRADE
// (referência + cor + tamanho, casando pelo idGrade sempre que a DAPIC o
// devolve) — para cruzar "quanto já produzi dessa grade" com "quanto tenho
// em estoque dela agora" (estoque-lote também é por idGrade). Uma grade
// pode aparecer em várias ordens ao longo do período; aqui somamos tudo.
// Só entra em "produzidoFinalizado" o que a DAPIC já marcou como concluído
// (Status contém concluí/finaliz/encerr) — peça ainda em produção não deveria
// ter saído do "produzido" pra bater com estoque, senão o comparativo mente.
function aggregateProducaoPorGrade(registros) {
  const map = new Map();
  for (const reg of registros) {
    const idGradeRaw = f(reg, "itemIdGrade");
    const idGrade = idGradeRaw !== undefined && idGradeRaw !== null ? String(idGradeRaw) : null;
    const ref = String(f(reg, "produtoRef") ?? "—");
    const cor = (f(reg, "itemCor") ?? "").toString();
    const tamanho = (f(reg, "itemTamanho") ?? "").toString();
    // Sem idGrade (registro incompleto) cai numa chave por ref+cor+tamanho —
    // menos preciso pra casar com o estoque, mas evita perder a linha.
    const key = idGrade ?? `ref:${ref}|${cor}|${tamanho}`;
    if (!map.has(key)) {
      map.set(key, {
        idGrade,
        ref,
        nome: f(reg, "produtoNome") ?? "Produto sem nome",
        cor,
        tamanho,
        colecao: (f(reg, "itemColecao") ?? "").toString(),
        produzidoTotal: 0,
        produzidoFinalizado: 0,
        ordens: 0,
        ultimaFinalizacao: null,
      });
    }
    const agg = map.get(key);
    const quantidade = Number(f(reg, "quantidade")) || 0;
    const status = (f(reg, "status") || "").toString();
    const finalizado = /conclu|finaliz|encerr/i.test(status);
    agg.produzidoTotal += quantidade;
    agg.ordens += 1;
    if (finalizado) {
      agg.produzidoFinalizado += quantidade;
      const dataFinal = parseAnyDate(f(reg, "itemDataFinalizacao"));
      if (dataFinal && (!agg.ultimaFinalizacao || dataFinal > agg.ultimaFinalizacao)) {
        agg.ultimaFinalizacao = dataFinal;
      }
    }
  }
  return map;
}

// Constrói um mapa idGrade -> {estoque, custo, preco, ref, nome, cor, tamanho}
// a partir do retorno de fetchEstoqueCompleto() (mesma fonte usada pelo
// Sell-through), pra casar com aggregateProducaoPorGrade() acima pela MESMA
// chave (idGrade). Grade que não aparece aqui = produto/grade fora do
// catálogo ativo (descontinuado) — o comparativo mostra "—" pra não fingir
// que o estoque é zero quando na verdade é desconhecido.
function estoquePorGrade(produtosComGrades) {
  const map = new Map();
  for (const p of produtosComGrades) {
    for (const g of p.grades || []) {
      if (g.idGrade === undefined || g.idGrade === null) continue;
      map.set(String(g.idGrade), {
        estoque: g.estoque || 0,
        custo: g.custo || 0,
        preco: g.preco || 0,
        ref: p.referencia,
        nome: p.nome,
        cor: g.cor,
        tamanho: g.tamanho,
      });
    }
  }
  return map;
}

/* ------------------------------- Sidebar --------------------------------- */

const NAV_ITEMS = [
  { href: "index.html", icon: "◆", label: "Sell-through" },
  { href: "producao.html", icon: "▤", label: "Produção" },
  { href: "pcp.html", icon: "⚙", label: "Sugestão PCP" },
  { href: "produtos.html", icon: "▥", label: "Curva ABC" },
];

function renderSidebar(activeHref) {
  const root = document.getElementById("sidebar-root");
  if (!root) return;
  const links = NAV_ITEMS.map(
    (item) => `
      <a href="${item.href}" class="${item.href === activeHref ? "active" : ""}">
        <span class="icon">${item.icon}</span>
        <span>${item.label}</span>
      </a>`
  ).join("");

  root.innerHTML = `
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="logo">Studio Lorena Vieira</div>
        <div class="sub">PCP Dashboard</div>
      </div>
      <nav class="nav">${links}</nav>
      <div class="sidebar-footer">
        <div class="status-row">
          <span class="status-dot loading" id="conn-dot"></span>
          <span id="conn-label">conectando…</span>
        </div>
        <div id="last-update">—</div>
      </div>
    </aside>`;
}

function setConnStatus(state, label) {
  const dot = document.getElementById("conn-dot");
  const lbl = document.getElementById("conn-label");
  if (!dot || !lbl) return;
  dot.className = "status-dot " + state;
  lbl.textContent = label;
}

function setLastUpdate() {
  const el = document.getElementById("last-update");
  if (!el) return;
  const now = new Date();
  el.textContent = "Atualizado às " + now.toLocaleTimeString("pt-BR");
}

/* ---------------------------- Tabela ordenável ---------------------------- */

function makeSortable(theadEl, getData, onSort) {
  const ths = theadEl.querySelectorAll("th[data-key]");
  let currentKey = null;
  let currentDir = 1;
  ths.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (currentKey === key) {
        currentDir *= -1;
      } else {
        currentKey = key;
        currentDir = 1;
      }
      ths.forEach((t) => t.classList.remove("sorted"));
      th.classList.add("sorted");
      const sorted = [...getData()].sort((a, b) => {
        const va = a[key];
        const vb = b[key];
        if (typeof va === "string") return va.localeCompare(vb) * currentDir;
        return ((va ?? 0) - (vb ?? 0)) * currentDir;
      });
      onSort(sorted);
    });
  });
}

/* ------------------------------- CSV export -------------------------------- */

function exportCSV(filename, headers, rows) {
  const escape = (v) => {
    const s = String(v ?? "");
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(";"), ...rows.map((r) => r.map(escape).join(";"))];
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* -------------------------------- Misc ------------------------------------- */

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
