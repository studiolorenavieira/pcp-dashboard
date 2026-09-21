// netlify/functions/dapic.js
//
// Proxy único e seguro para a API DAPIC.
// - Autentica server-side (o token nunca chega ao browser)
// - Renova o bearer token automaticamente quando expira/expira em breve
// - Busca TODAS as páginas de um endpoint automaticamente
// - Tenta variações de rota quando recebe 404
// - Cacheia (em memória, por instância "quente" da function) o token e
//   respostas recentes para reduzir chamadas repetidas à DAPIC
//
// Uso: GET /api/dapic?endpoint=v1/vendaspdv&DataInicial=2026-01-01&DataFinal=2026-09-17

const DAPIC_BASE = "https://api.dapic.app";

// Endpoints permitidos (whitelist) e variações a tentar em caso de 404.
// A primeira entrada de cada array é o endpoint "canônico" do spec.
const ENDPOINT_VARIANTS = {
  "v1/vendaspdv": ["v1/vendaspdv", "v1/venda", "v1/vendas", "v1/pdv", "v1/vendapdv"],
  "v1/pedidosvendas": ["v1/pedidosvendas", "v1/pedidosvenda", "v1/pedidovendas", "v1/pedidos"],
  "v1/faturas": ["v1/faturas", "v1/fatura", "v1/notasfiscais", "v1/nfe"],
  "v1/ordensproducao": ["v1/ordensproducao", "v1/ordemproducao", "v1/ordensdeproducao", "v1/op"],
  "v1/estoques": ["v1/estoques", "v1/estoque", "v1/posicaoestoque"],
  "v1/produtos": ["v1/produtos", "v1/produto", "v1/cadastroprodutos"],
};

const REGISTROS_POR_PAGINA = 200;
const MAX_PAGINAS = 150; // trava de segurança (30.000 registros)
const TOKEN_SAFETY_MARGIN_MS = 60 * 1000; // renova 60s antes de expirar
const RESPONSE_CACHE_TTL_MS = 45 * 1000; // cache curto p/ chamadas simultâneas do dashboard

// Cache em memória — sobrevive entre invocações enquanto a function
// estiver "quente" (mesma instância), mas nunca é garantido entre chamadas.
let tokenCache = { token: null, expiresAt: 0 };
const responseCache = new Map();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

function parseValidade(dataValidade) {
  // DAPIC retorna algo como uma data ISO. Se não conseguirmos parsear,
  // assumimos uma validade curta (5 min) para forçar renovação frequente
  // em vez de arriscar usar um token expirado.
  const t = Date.parse(dataValidade);
  if (!Number.isNaN(t)) return t;
  return Date.now() + 5 * 60 * 1000;
}

function parseExpiresIn(expiresInSeconds) {
  // DAPIC retorna "expires_in" como duração em segundos (padrão OAuth2),
  // não uma data. Ex.: "86400" = 24h a partir de agora.
  const n = Number(expiresInSeconds);
  if (!Number.isNaN(n) && n > 0) return Date.now() + n * 1000;
  return Date.now() + 5 * 60 * 1000;
}

async function login() {
  const identificador = process.env.DAPIC_IDENTIFICADOR;
  const token = process.env.DAPIC_TOKEN;

  if (!identificador || !token) {
    throw new Error(
      "Variáveis de ambiente DAPIC_IDENTIFICADOR / DAPIC_TOKEN não configuradas no Netlify."
    );
  }

  // A API DAPIC respondeu exigindo o campo "Empresa" (não documentado publicamente).
  // Enviamos as duas variações de nome para funcionar com qualquer uma que a API espere.
  const res = await fetch(`${DAPIC_BASE}/autenticacao/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      Empresa: identificador,
      TokenIntegracao: token,
    }),
  });

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`Falha na autenticação DAPIC (${res.status}): ${text}`);
  }

  const data = await res.json();
  // A DAPIC usa o formato padrão OAuth2: access_token / expires_in / token_type.
  const bearer =
    data.access_token || data.Token || data.token || data.AccessToken ||
    data.accessToken || data.Bearer || data.bearer || data.TokenAcesso ||
    data.tokenAcesso || data.TokenSessao || data.Authorization;
  if (!bearer) {
    // Mostra a resposta crua para descobrirmos o nome real do campo.
    throw new Error(
      "Resposta de login da DAPIC não trouxe um Token. Resposta crua: " + JSON.stringify(data)
    );
  }

  const expiresAt = data.expires_in
    ? parseExpiresIn(data.expires_in)
    : parseValidade(data.DataValidade || data.dataValidade);

  tokenCache = {
    token: bearer,
    expiresAt: expiresAt - TOKEN_SAFETY_MARGIN_MS,
  };

  return tokenCache.token;
}

async function getToken(forceRefresh = false) {
  if (!forceRefresh && tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  return login();
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// Encontra o array de registros dentro do payload retornado pela DAPIC,
// independentemente do nome exato da propriedade usado.
function extractArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const candidateKeys = [
    "Dados", "dados", "Data", "data", "Registros", "registros",
    "Items", "items", "Result", "result", "Value", "value",
    "Lista", "lista", "Content", "content",
  ];
  for (const key of candidateKeys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  // fallback: primeira propriedade do objeto que seja um array
  for (const key of Object.keys(payload)) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function extractTotal(payload, fallback) {
  if (!payload || typeof payload !== "object") return fallback;
  const candidateKeys = [
    "Total", "total", "TotalRegistros", "totalRegistros",
    "TotalCount", "totalCount", "Count", "count",
  ];
  for (const key of candidateKeys) {
    if (typeof payload[key] === "number") return payload[key];
  }
  return fallback;
}

async function fetchSinglePage(endpointPath, params, pagina, token) {
  const url = new URL(`${DAPIC_BASE}/${endpointPath}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });
  url.searchParams.set("Pagina", String(pagina));
  url.searchParams.set("RegistrosPorPagina", String(REGISTROS_POR_PAGINA));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  return res;
}

// Busca todas as páginas de um endpoint, tentando variações de rota em
// caso de 404 e renovando o token uma vez em caso de 401.
async function fetchAllPages(canonicalEndpoint, params) {
  const variants = ENDPOINT_VARIANTS[canonicalEndpoint] || [canonicalEndpoint];
  let lastError = null;

  for (const endpointPath of variants) {
    try {
      const result = await fetchAllPagesForPath(endpointPath, params);
      return { ...result, endpointUsed: endpointPath };
    } catch (err) {
      if (err.status === 404) {
        lastError = err;
        continue; // tenta a próxima variação
      }
      throw err;
    }
  }
  throw lastError || new Error("Nenhuma variação de endpoint funcionou.");
}

async function fetchAllPagesForPath(endpointPath, params) {
  let token = await getToken();
  let all = [];
  let pagina = 1;
  let total = null;
  let triedRefresh = false;

  while (pagina <= MAX_PAGINAS) {
    let res = await fetchSinglePage(endpointPath, params, pagina, token);

    if (res.status === 401 && !triedRefresh) {
      triedRefresh = true;
      token = await getToken(true);
      res = await fetchSinglePage(endpointPath, params, pagina, token);
    }

    if (res.status === 404) {
      const err = new Error(`Endpoint ${endpointPath} retornou 404`);
      err.status = 404;
      throw err;
    }

    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`Erro DAPIC em ${endpointPath} (${res.status}): ${text}`);
    }

    const payload = await res.json();
    const pageItems = extractArray(payload);
    total = extractTotal(payload, total);

    all = all.concat(pageItems);

    if (pageItems.length < REGISTROS_POR_PAGINA) {
      break; // última página
    }
    pagina += 1;
  }

  return { dados: all, total: total ?? all.length };
}

function cacheKey(endpoint, params) {
  return endpoint + "::" + JSON.stringify(params);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { erro: "Método não permitido. Use GET." });
  }

  const qs = event.queryStringParameters || {};

  // Modo de debug temporário: testa um caminho arbitrário na DAPIC para
  // descobrirmos os nomes reais dos endpoints (a API não é documentada
  // publicamente). Uso: /api/dapic?raw=v1/algumacoisa
  // TODO: remover depois que todos os endpoints forem confirmados.
  if (qs.raw) {
    try {
      const token = await getToken();
      const url = new URL(`${DAPIC_BASE}/${qs.raw}`);
      url.searchParams.set("Pagina", qs.pagina || "1");
      url.searchParams.set("RegistrosPorPagina", qs.tamanho || "5");
      if (qs.DataInicial) url.searchParams.set("DataInicial", qs.DataInicial);
      if (qs.DataFinal) url.searchParams.set("DataFinal", qs.DataFinal);
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await safeText(res);
      let resumo = null;
      try {
        const parsed = JSON.parse(text);
        const arr = extractArray(parsed);
        resumo = {
          chavesRaiz: parsed && typeof parsed === "object" ? Object.keys(parsed) : null,
          quantidadeItens: arr.length,
          total: extractTotal(parsed, null),
          primeiroItem: arr[0] || parsed,
          chavesPrimeiroItem: arr[0] ? Object.keys(arr[0]) : null,
        };
      } catch {
        // corpo não é JSON válido; ignora resumo
      }
      return jsonResponse(200, {
        pathTestado: qs.raw,
        status: res.status,
        resumo,
        corpo: text.slice(0, 1200),
      });
    } catch (err) {
      return jsonResponse(200, { pathTestado: qs.raw, erro: err.message });
    }
  }

  const endpoint = qs.endpoint;

  if (!endpoint || !ENDPOINT_VARIANTS[endpoint]) {
    return jsonResponse(400, {
      erro: "Parâmetro 'endpoint' ausente ou não permitido.",
      endpointsPermitidos: Object.keys(ENDPOINT_VARIANTS),
    });
  }

  const params = {};
  if (qs.DataInicial) params.DataInicial = qs.DataInicial;
  if (qs.DataFinal) params.DataFinal = qs.DataFinal;

  const key = cacheKey(endpoint, params);
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.at < RESPONSE_CACHE_TTL_MS) {
    return jsonResponse(200, { ...cached.body, cache: true });
  }

  try {
    const result = await fetchAllPages(endpoint, params);
    const body = { dados: result.dados, total: result.total, endpointUsado: result.endpointUsed };
    responseCache.set(key, { at: Date.now(), body });
    return jsonResponse(200, body);
  } catch (err) {
    return jsonResponse(502, { erro: err.message || "Erro desconhecido ao consultar a DAPIC." });
  }
};
