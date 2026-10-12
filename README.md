# Conty. Métricas das redes do criador

Serviço que sincroniza as métricas dos posts de uma conexão já autorizada (Instagram, TikTok, YouTube, X), com provedor simulado. Sem OAuth: o token é fictício. Stack: Node 22, TypeScript estrito, Hono, Vitest.

```bash
npm install
npm test          # relógio controlado, sem esperas reais
npm run typecheck
npm run dev       # http://127.0.0.1:3004 (dados em memória, provedor simulado com 5 posts)
```

## Estrutura

`src/provider.ts` é o contrato do provedor (busca uma página e falha como HTTP: timeout, 5xx, 429 com o `Retry-After` cru) e `src/simulated-provider.ts` é o provedor falso, com falhas roteirizadas. Toda a regra de negócio está em `src/sync.ts` (paginação, retry, espera do 429, deduplicação), que só conhece a interface e o `Clock` injetado. `src/store.ts` guarda os dados e tem o `upsert` idempotente. Nos testes, o relógio não espera: `sleep` avança o "agora" e registra o tempo pedido. Trocar o simulador por um cliente real é implementar `MetricsProvider`.

## API

| Rota | O que faz |
| --- | --- |
| `POST /connections` | `{platform, account_id, access_token}`. Responde sem o token. |
| `POST /connections/:id/syncs` | `{since, until}` (ISO 8601 com fuso). Roda o sync e responde ao terminar. |
| `GET /connections/:id/syncs` | Histórico de execuções. |
| `GET /connections/:id/posts` | Posts com métricas e datas. |
| `GET /connections/:id/metrics` | Totais (cada post uma vez), `oldest_fetched_at`, `last_fetched_at`. |

`POST /syncs` responde `200` com a execução, `429` + `Retry-After` quando o provedor pediu mais do que o teto, e `502` nas demais falhas. O corpo é sempre a execução. A janela é de `published_at` em `[since, until)`.

## Idempotência

- A identidade de um post é **(conexão, id do post)**. Os contadores do provedor são **absolutos** ("este post tem 1500 views"), então receber o post de novo o **substitui**, nunca soma.
- Cada snapshot traz `metricsAsOf`, o instante em que o provedor leu os números. No `upsert`:
  - nunca visto: `inserted`;
  - `metricsAsOf` igual ao guardado: mesmo snapshot, `unchanged` (nada muda);
  - mais novo: `updated`, os contadores são trocados;
  - mais antigo: `stale`, ignorado (uma resposta atrasada não devolve o número ao passado).
- **Janelas sobrepostas:** um post na interseção chega nos dois syncs com a mesma chave, então cai em `unchanged` ou `updated` no segundo. O total soma o último snapshot de cada post, uma vez.
- **Resposta repetida:** o mesmo post duas vezes na mesma página é colapsado antes de gravar (fica o `metricsAsOf` mais novo) e contado em `duplicates_in_response`.
- **Dado inválido:** post com id vazio, data ilegível ou contador negativo/`NaN` é descartado e contado em `counts.invalid`. Nunca sobrescreve o número guardado.
- **Mesmo `metricsAsOf` com contadores diferentes:** conta como o mesmo snapshot (`unchanged`); o primeiro vale.
- **Falha no meio:** cada página é gravada ao chegar. Se a página 2 falha, a 1 fica, e rodar o sync de novo é seguro pelo mesmo motivo.
- Syncs da mesma conexão rodam em fila. A fila dá ordem previsível e evita chamadas duplicadas ao provedor; a idempotência vem do `upsert`, não dela. Os testes usam um provedor com "portão" para provar que o segundo sync só chama o provedor depois do primeiro terminar, e que conexões diferentes não se bloqueiam.

## Quando a métrica foi buscada

Cada post tem `fetched_at` (nosso relógio, última vez que recebemos e aceitamos ou confirmamos o dado) e `metrics_as_of` (leitura do provedor). Cada execução tem `started_at`, `finished_at`, `waited_ms` e as tentativas (`retries[].at`). `GET /metrics` devolve o mais antigo e o mais recente.

## Falhas e limite de taxa

Tudo é configurável em `SyncConfig` (padrões em `DEFAULT_CONFIG`). O limite de tentativas vale **por página**; o de espera total vale **por sync**.

| Situação | Comportamento |
| --- | --- |
| Timeout (`requestTimeoutMs`, o provedor também recebe um `AbortSignal`) ou `5xx` | Retry com backoff exponencial `500ms, 1s, 2s…` até `maxBackoffMs`. |
| `429` com `Retry-After` | Espera **exatamente** esse prazo (segundos ou data HTTP) e tenta de novo. |
| `429` com `Retry-After` maior que `maxRetryAfterMs` | O sync falha na hora com `rate_limited` e `retry_after_ms`, sem dormir. Esperar menos do que o provedor pediu só traria outro 429. |
| `429` sem `Retry-After` válido | Cai no backoff acima. |
| `401`/`403` | Não repete (`unauthorized`). |
| Teto de `maxAttempts` (padrão 4, a primeira incluída) | Falha com `retries_exhausted`. Não dorme depois da última tentativa. |
| Espera somada de todo o sync passaria de `maxTotalWaitMs` (padrão 120 s) | Falha com `wait_budget_exceeded`, sem dormir o que passaria. |
| Mais de `maxPages` páginas | Falha com `too_many_pages`. |

Os testes de 429 (`test/sync.test.ts`) usam o relógio controlado: conferem que o `sleep` pedido foi o `Retry-After` (em segundos e em data HTTP), que o "agora" avançou exatamente isso, que o teto é respeitado (inclusive o valor igual ao teto) e que 429 repetido para em `maxAttempts`.

## O que ficou de fora

- Persistência: tudo em memória. O `upsert` viraria `INSERT … ON CONFLICT` com chave `(connection_id, post_id)`.
- Job assíncrono: `POST /syncs` fica aberto até o fim (limitado pelo teto total de espera). Em produção seria um job com `GET` para consultar.
- Jitter no backoff e um simulador por plataforma.

## IA

- **Feito com IA:** Claude Code (Sonnet 5.5) escreveu o código, os testes e este README a partir do enunciado.
- **Execução:** a IA rodou `npm test`, `npm run typecheck` e `curl` contra a API local.
- **Sanity check:** um subagente do Claude Code, sem o histórico da conversa, leu só o enunciado e o repositório, rodou os testes, subiu a API e mutou uma cópia do código para ver quais testes continuavam verdes. Achou e foi corrigido: `Retry-After` malformado (`"1.5"`, `"-5"`) virava espera zero; datas como `since: "1"` eram aceitas; testes não cobriam a fronteira `until`, o snapshot mais novo dentro da mesma resposta e `last_fetched_at` com valores diferentes. Apontou ainda a falta de teto total de espera e de validação dos dados do provedor, corrigidas numa segunda rodada, em que outro subagente avaliou excesso de engenharia; cortei `/health`, `first_fetched_at`, `last_sync_id`, `pages`, a janela de 90 dias e testes repetidos.
- **Revisado por mim:**
  - Li `upsert` e `fetchPage` e conferi que o upsert substitui os contadores em vez de somar. Troquei por soma e vi falharem os testes de snapshot novo e de janela sobreposta.
  - Percebi que o teste da fila por conexão passaria mesmo sem a fila. Pedi uma forma de testá-la e conferi o teste com provedor com "portão": removendo a fila, ele falha.
  - Rodei os testes e um roteiro manual com 429, 503 e snapshot novo, e os resultados bateram com o esperado.
  - Concordei com falhar na hora quando o `Retry-After` passa do teto, em vez de esperar menos, porque isso só traria outro 429.
