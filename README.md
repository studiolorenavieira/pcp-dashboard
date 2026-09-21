# PCP Dashboard — Studio Lorena Vieira

Cruza produção + vendas + estoque em tempo real (via API DAPIC) para decisões de
PCP (Planejamento e Controle da Produção) baseadas em dados.

## Arquitetura

- **Backend**: uma Supabase Edge Function (`supabase/functions/pcp-dapic/index.ts`,
  projeto `lrtphrdqyeoblbwwnujv`) que autentica na DAPIC server-side, renova o token
  automaticamente (cacheado em `pcp_dapic_token`), busca todas as páginas de um
  endpoint e devolve `{ dados, total }`. O token da DAPIC nunca é exposto ao browser.
  O saldo de estoque (sem endpoint de listagem na DAPIC) é buscado em lotes por
  produto e cacheado em `pcp_estoque_cache` (TTL de 1h), respeitando o rate limit de
  60 req/min da DAPIC.
- **Frontend**: HTML/CSS/JS puro, sem frameworks e sem build — publicado no GitHub
  Pages (deploy automático via GitHub Actions a cada push na `main`). Tudo vem da
  DAPIC em tempo real, via a Edge Function acima.

## Telas

| Arquivo | Conteúdo |
|---|---|
| `public/index.html` | Sell-through & ranking de produtos, dead stock |
| `public/producao.html` | Ordens de produção em tempo real, linha do tempo por mês |
| `public/pcp.html` | Sugestão de produção (reposição calculada + cápsula manual) |
| `public/produtos.html` | Curva ABC dinâmica + histórico de sazonalidade por produto |

## Variáveis de ambiente / segredos (Supabase)

Configurados em *Project settings → Edge Functions → Secrets* do projeto
`lrtphrdqyeoblbwwnujv`:

- `DAPIC_IDENTIFICADOR`
- `DAPIC_TOKEN`

A chave pública do Supabase (`sb_publishable_...`) usada pelo frontend para chamar a
Edge Function fica em `public/shared.js` — ela não dá acesso a nada sensível, é só a
chave de gateway do Supabase (equivalente à `anon key`).

## Nota sobre os nomes de campo da API DAPIC

A DAPIC não documenta publicamente os nomes exatos de cada campo. `public/shared.js`
usa uma camada de normalização (`FIELD_ALIASES` + `getField`) que tenta várias
variações plausíveis de nome. Se algum painel aparecer vazio, abra o Console do
navegador: cada chamada loga uma amostra do primeiro registro cru retornado pela
API — isso mostra o nome real do campo, que pode então ser adicionado em
`FIELD_ALIASES` (um único lugar, no topo de `shared.js`).

## Histórico

O projeto rodou inicialmente em Netlify Functions + Netlify Hosting. Foi migrado
para Supabase Edge Functions + GitHub Pages para não depender do modelo de créditos
do Netlify (que se esgotava com deploys frequentes durante o desenvolvimento). Os
arquivos antigos (`netlify/`, `netlify.toml`) ficaram no repositório por enquanto,
mas não são mais usados no deploy atual.
