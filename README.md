# PCP Dashboard — Studio Lorena Vieira

Cruza produção + vendas + estoque em tempo real (via API DAPIC) para decisões de
PCP (Planejamento e Controle da Produção) baseadas em dados.

## Arquitetura

- **Backend**: uma única Netlify Function (`netlify/functions/dapic.js`) que autentica
  na DAPIC server-side, renova o token automaticamente, busca todas as páginas de um
  endpoint e devolve `{ dados, total }`. O token da DAPIC nunca é exposto ao browser.
- **Frontend**: HTML/CSS/JS puro, sem frameworks e sem banco de dados — tudo vem da
  DAPIC em tempo real, via `/api/dapic?endpoint=...`.

## Telas

| Arquivo | Conteúdo |
|---|---|
| `public/index.html` | Sell-through & ranking de produtos, dead stock |
| `public/producao.html` | Ordens de produção em tempo real, linha do tempo por mês |
| `public/pcp.html` | Sugestão de produção (reposição calculada + cápsula manual) |
| `public/produtos.html` | Curva ABC dinâmica + histórico de sazonalidade por produto |

## Variáveis de ambiente (Netlify)

Configurar em *Site settings → Environment variables*:

- `DAPIC_IDENTIFICADOR`
- `DAPIC_TOKEN`

Veja `.env.example`.

## Desenvolvimento local

```bash
npm install -g netlify-cli
netlify dev
```

## Nota sobre os nomes de campo da API DAPIC

A DAPIC não documenta publicamente os nomes exatos de cada campo. `public/shared.js`
usa uma camada de normalização (`FIELD_ALIASES` + `getField`) que tenta várias
variações plausíveis de nome. Se algum painel aparecer vazio, abra o Console do
navegador: cada chamada loga uma amostra do primeiro registro cru retornado pela
API — isso mostra o nome real do campo, que pode então ser adicionado em
`FIELD_ALIASES` (um único lugar, no topo de `shared.js`).

## Limitações conhecidas

- Netlify Functions (plano padrão) têm timeout de ~10s por invocação. Se um endpoint
  tiver muitas páginas de dados no período consultado, a função pode estourar esse
  limite. Se isso acontecer, considere: (a) upgrade do plano Netlify (26s de timeout),
  ou (b) consultar períodos mais curtos nas telas.
