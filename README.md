# Conty. Métricas das redes do criador

Serviço que sincroniza as métricas dos posts de uma conexão já autorizada (Instagram, TikTok, YouTube, X), com provedor simulado. Sem OAuth: o token é fictício. Stack: Node 22, TypeScript estrito, Hono, Vitest.

```bash
npm install
npm test          # 47 testes, relógio controlado
npm run typecheck
npm run dev       # http://127.0.0.1:3004 (dados em memória, provedor simulado com 5 posts)
```

## Estrutura (a fronteira)

| Arquivo | Papel |
| --- | --- |
| `src/provider.ts` | O contrato do provedor: busca **uma página** e falha com erros no formato HTTP (timeout, 5xx, 429 com o header `Retry-After` cru). Não tem regra de negócio. |
| `src/simulated-provider.ts` | Provedor falso. Falhas roteirizadas (`failNext`), posts e snapshots criados pelo teste. |
| `src/sync.ts` | Regra de negócio: paginação, retry, espera do 429, deduplicação. Só fala com a interface do provedor e com o `Clock`. |
| `src/store.ts` | Guarda posts e execuções. Aqui mora o `upsert` idempotente. |
| `src/app.ts` | API HTTP. |
| `src/clock.ts` | `now()` e `sleep()` injetáveis. Os testes usam um relógio que não espera: `sleep` só avança o "agora" e registra o tempo pedido. |

Trocar o simulador por um cliente real é implementar `MetricsProvider`; nada em `sync.ts` muda.

## API

| Rota | O que faz |
| --- | --- |
| `POST /connections` | `{platform, account_id, access_token}`. Responde sem o token. |
| `POST /connections/:id/syncs` | `{since, until}` (ISO 8601 com fuso, no máximo 90 dias). Roda o sync e responde ao terminar. |
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
- **Falha no meio:** cada página é gravada ao chegar. Se a página 2 falha, a 1 fica, e rodar o sync de novo é seguro pelo mesmo motivo.
- Syncs da mesma conexão rodam em fila. Reconhecendo com franqueza: a ausência de contagem dupla vem do `upsert`, que é síncrono; a fila só deixa a ordem previsível e cada execução com contagens coerentes.

## Quando a métrica foi buscada

Cada post tem `fetched_at` (nosso relógio, última vez que recebemos e aceitamos ou confirmamos o dado), `first_fetched_at` e `metrics_as_of` (leitura do provedor). Cada execução tem `started_at`, `finished_at`, as tentativas (`retries[].at`) e `last_sync_id` aponta qual execução tocou o post por último. `GET /metrics` devolve o mais antigo e o mais recente.

## Falhas e limite de taxa

Tudo é configurável em `SyncConfig` (padrões em `DEFAULT_CONFIG`). O limite vale **por página**.

| Situação | Comportamento |
| --- | --- |
| Timeout (`requestTimeoutMs`, o provedor também recebe um `AbortSignal`) ou `5xx` | Retry com backoff exponencial `500ms, 1s, 2s…` até `maxBackoffMs`. |
| `429` com `Retry-After` | Espera **exatamente** esse prazo (segundos ou data HTTP) e tenta de novo. |
| `429` com `Retry-After` maior que `maxRetryAfterMs` | O sync falha na hora com `rate_limited` e `retry_after_ms`, sem dormir. Esperar menos do que o provedor pediu só traria outro 429. |
| `429` sem `Retry-After` válido | Cai no backoff acima. |
| `401`/`403` | Não repete (`unauthorized`). |
| Teto de `maxAttempts` (padrão 4, a primeira incluída) | Falha com `retries_exhausted`. Não dorme depois da última tentativa. |
| Mais de `maxPages` páginas | Falha com `too_many_pages`. |

Os testes de 429 (`test/sync.test.ts`) usam o relógio controlado: conferem que o `sleep` pedido foi o `Retry-After` (em segundos e em data HTTP), que o "agora" avançou exatamente isso, que o teto é respeitado (inclusive o valor igual ao teto) e que 429 repetido para em `maxAttempts`.

## O que ficou de fora

- Persistência: tudo em memória. O `upsert` viraria `INSERT … ON CONFLICT` numa tabela com chave `(connection_id, post_id)`.
- Teto **total** de duração de um sync: há teto por espera e por tentativa, mas somando páginas o pior caso ainda é longo, e `POST /syncs` fica aberto até terminar. Em produção seria um job assíncrono com `GET` para consultar.
- Jitter no backoff.
- Um simulador por plataforma: as quatro só diferem no rótulo.
- A mesma conta do provedor conectada duas vezes conta o mesmo post em duas conexões (a chave é por conexão).
- O teste de timeout que nunca responde usa um `setTimeout` real de 20 ms, porque o timeout é do ambiente e não do `Clock`.

## IA

- **Feito com IA:** Claude Code (Sonnet 5.5) escreveu o código, os testes e este README a partir do enunciado.
- **Execução:** a IA rodou `npm test`, `npm run typecheck` e `curl` contra a API local.
- **Sanity check:** um subagente do Claude Code, sem o histórico da conversa, leu só o enunciado e o repositório, rodou os testes, subiu a API e mutou uma cópia do código para ver quais testes continuavam verdes. Achou e foi corrigido: `Retry-After` malformado (`"1.5"`, `"-5"`) virava espera zero; datas como `since: "1"` eram aceitas; testes não cobriam a fronteira `until`, o snapshot mais novo dentro da mesma resposta e `last_fetched_at` com valores diferentes. Apontou e ficou documentado acima: teto total de duração e persistência.
- **Revisado por mim:** (preencher após a sua revisão)
