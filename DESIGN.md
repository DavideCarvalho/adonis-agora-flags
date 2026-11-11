# `@adonis-agora/flags` — DESIGN

> Feature flags, testes A/B e a análise deles para AdonisJS, rodando no banco que o app já tem.
> Começa no OLTP (Postgres/MySQL via Lucid) e sobe para OLAP (Parquet + DuckDB, ClickHouse) sem
> mudar o código das flags. Fala o vocabulário do OpenFeature.

Status: desenho aprovado e implementado em 2026-11-11 (repo local, nada publicado). Este
documento registra as decisões; a doc de uso fica em `docs/` (site do Agora). §16 lista o que
mudou em relação ao desenho original durante a implementação.

## 1. Pacotes

| Pacote | O que é | Depende de Adonis? |
|---|---|---|
| `@adonis-agora/flags-core` | Motor de avaliação, formato do ruleset, contrato de evento, estatística | Não (puro, roda em qualquer runtime) |
| `@adonis-agora/flags` | Provider, `defineConfig`, stores, transports, sinks, relay, comandos, middleware, Edge/Inertia | Sim |
| `@adonis-agora/flags-dashboard` | Console (SPA) no padrão dos outros consoles do Agora | — |
| `@adonis-agora/flags-react` | `useFlag()` em cima dos valores avaliados que o servidor compartilha | — |
| `@adonis-agora/flags/openfeature` (subpath) | Provider do OpenFeature sobre o mesmo motor | — |

O motor fica num pacote puro porque o control-plane (preview no console) e os tenants precisam
avaliar **exatamente** igual. É o mesmo motivo do `authkit-core`.

## 2. Separação fundamental

| | Avaliar | Medir |
|---|---|---|
| O que faz | Lê config | Grava exposição e conversão |
| Frequência | Toda request, várias vezes | Uma linha por usuário/evento |
| Precisa de | Microssegundos, zero I/O | Volume, durabilidade, agregação |
| Onde roda | Memória do processo | Transport → relay → sinks |

O banco **nunca** está no caminho quente da avaliação.

## 3. Flags no código, regras no banco

- Cada flag é declarada em código: key, tipo, valor padrão, descrição, dono, expiração.
  O TypeScript checa key e tipo (`flags.variant('checkout_v2')`), via declaration merging.
- O banco (ou o control-plane) guarda só o ruleset: ligado/desligado, regras, rollout,
  overrides, segmentos.
- Se o store cair ou a flag não existir no ruleset, a avaliação devolve o padrão do código.
  Nunca lança.

## 4. Ruleset (contrato público, versionado)

JSON serializável com `schemaVersion`. Definido em `flags-core/src/ruleset.ts`.

- `flags[key]`: `enabled`, `variants` (nome → valor JSON), `offVariant`, `rules` (em ordem),
  `fallthrough`, `overrides` (targetingKey → variante), `prerequisites`, `salt`.
- `serve`: uma variante fixa **ou** um split com pesos (`bucketBy` opcional: user, org, etc.).
- `conditions`: atributo + operador + valores (AND dentro da regra), ou referência a segmento.
- Operadores: `in`, `contains`, `startsWith`, `endsWith`, `matches`, `gt/gte/lt/lte`,
  `before/after`, `semverEq/Gt/Gte/Lt/Lte`, `exists`; todos com `negate`.
- **Falha fechada:** operador desconhecido, versão de schema maior que a suportada ou ciclo de
  pré-requisito → a flag inteira devolve o padrão do código com `errorCode: 'PARSE_ERROR'`.
  Nunca avalia "mais ou menos". É o que permite um control-plane mais novo que os tenants.

## 5. Avaliação

- Determinística: `bucket = murmur3(salt:flag:bucketKey) mod 10000`. Mesmo usuário, mesma
  variante, em qualquer réplica, sem gravar nada.
- Devolve os detalhes no formato do OpenFeature:
  `{ flagKey, value, variant, reason, errorCode?, errorMessage?, flagMetadata }`.
  - `reason`: `STATIC` | `DEFAULT` | `TARGETING_MATCH` | `SPLIT` | `DISABLED` | `ERROR`.
  - `errorCode`: `FLAG_NOT_FOUND` | `PARSE_ERROR` | `TYPE_MISMATCH` | `TARGETING_KEY_MISSING` |
    `INVALID_CONTEXT` | `GENERAL`.
- Contexto: `targetingKey` (o `subject` do authz / `sub` do authkit) + atributos.
  Atributos que decidem targeting só vêm de fonte confiável no servidor.
- Memoização por request: a mesma request nunca vê dois valores da mesma flag.
- Último estado bom: se o store cair depois do boot, segue com o último ruleset.
- Invalidação: `LISTEN/NOTIFY` (Postgres), pub/sub do Redis, ou polling por `version`.

## 6. Exposição ≠ avaliação

Exposição só é registrada quando o código **usa** a variante de um experimento.
Dedupe por `(experiment, subject)`. Conversões (`flags.track()`) aceitam a trx do Lucid.

## 7. Contrato de evento (igual em todos os destinos)

```
event_id (uuidv7) · schema_version · app · type (exposure|track) · flag · experiment · variant
subject · subject_type · value · props (json) · ts
```

`event_id` de exposição é determinístico a partir de `(experiment, subject)`, para o destino
deduplicar reenvios.

## 8. Transports, relay e sinks

```
track()/exposure ──► buffer em processo ──► Transport ──► relay ──► Sinks
                     (lote, dedupe)          db | redis       lucid | posthog | clickhouse | parquet
```

- **Transport** declara `capabilities: { transactional, durable }`.
  - `db`: tabela append-only (particionada por tempo, BRIN em `ts`). É o único transacional.
  - `redis`: Streams com consumer group por sink.
  - `sync`: dev/testes.
  - Com transport não transacional, `track(..., { client: trx })` emite em `after('commit')`
    e o boot avisa uma vez.
- **Relay**: cursor por sink (`flag_sink_cursors(sink, last_id, leased_by, lease_until)`).
  Lease por `UPDATE ... RETURNING` (sem transação aberta durante o envio). At-least-once;
  o destino deduplica por `event_id`.
- **Sinks**: `lucid` (tabelas de análise + rollup), `posthog`, `clickhouse`, `parquet`.
  Transport `db` + sink `lucid` no mesmo banco não copia: o rollup roda em cima do log.
- **Enrichers** (síncronos, fora do transport): Sentry, OTel, telescope via diagnostics.
  O telescope nunca é sink: ele descarta sob carga, e descarte enviesa experimento.

## 9. Vocabulário de deploy (padrão do ecossistema)

Segue `_1x/ROLE-VOCABULARY-SPEC.md`:

- `role: 'all' | 'api' | 'worker'` — que parte do deploy é este processo.
- `dispatcher: 'auto' | 'durable' | 'in-process'` — quem roda o relay.
  `auto` = durable se o provider estiver registrado, senão in-process com lease.
- `node ace flags:work [--sink=x] [--once]` — o loop do relay fora do processo web.
- `topology: 'standalone' | 'control-plane' | 'tenant'`, com `partition`, `tenant: { token }`,
  `verifyTenant`, `capabilities`. Num `tenant`, `store`/`stores` são `never`.

| | `all` | `api` | `worker` |
|---|---|---|---|
| `standalone` | tudo no processo (padrão) | avalia e grava eventos | só `flags:work` |
| `control-plane` | serve ruleset, recebe eventos, fan-out | API + console | só fan-out |
| `tenant` | avalia e manda eventos ao control-plane | igual a `all` | recusado no boot |

## 10. Topologia central

- O tenant **avalia localmente**: baixa o ruleset (SSE com fallback para polling por `ETag`),
  guarda snapshot local (último estado bom) e avalia em memória.
- Eventos do tenant vão por HTTP em lote ao control-plane, que faz o fan-out aos sinks.
- No deploy, o tenant publica o schema das flags dele (keys, tipos, padrões, descrições) para o
  console saber o que existe.
- `capabilities` carrega o `schemaVersion` que o tenant entende.
- Um mesmo usuário tem o mesmo `subject` em todos os apps (authkit) → experimento entre apps.

## 11. Segurança e authkit (opcional)

- Tenant ↔ control-plane: `client_credentials` no authkit-server, JWT curto com
  `aud: flags` e scopes `flags:ruleset:read flags:events:write`. `verifyTenant` valida por
  JWKS e tira a `partition` do token, nunca do corpo. Stream SSE fecha no `exp`.
- Alternativa sem authkit: segredo compartilhado.
- Console: `authorize: authkitDashboardAuthorize(...)`, como os outros consoles.
- Permissões por flag/projeto/ambiente no authz. Aprovação em duas pessoas: quem pede não aprova.
- Audit log com o `sub`.
- Frontend recebe só valores avaliados, nunca regras.

## 12. Análise: o banco agrega, o TypeScript infere

```
eventos ──► backend (Postgres | DuckDB | ClickHouse) ──► estatísticas suficientes ──► stats em TS
```

- Backends devolvem por variante: `n`, `Σx`, `Σx²`, e para CUPED `Σx_pre`, `Σx_pre²`, `Σx·x_pre`.
- Inferência única em `flags-core/src/stats.ts`: z-test de proporções, Welch, SRM
  (qui-quadrado), depois CUPED e sequential (always-valid). Sequential é só matemática; roda em
  qualquer backend.
- Métricas declaradas em código (`defineMetric`) e compiladas para cada dialeto.

Níveis:
1. **Postgres** (padrão): log particionado, rollup diário, agregado por subject.
2. **Parquet + DuckDB**: partições fechadas viram Parquet (`experiment=…/date=…/`) no drive;
   DuckDB lê direto. DuckDB é peer opcional (binário nativo) e roda só em `worker`/job.
3. **ClickHouse**: sink com `async_insert`, `ReplacingMergeTree`, materialized views.

Subir de nível = adicionar um sink; o cursor novo começa do zero e faz o backfill.

## 13. OpenFeature

- Vocabulário no núcleo (detalhes de avaliação, reasons, error codes, `targetingKey`, hooks,
  `track`, atributos OTel de feature flag).
- Provider oficial no subpath `/openfeature`.
- Endpoint OFREP no control-plane: SDKs de browser/mobile/outras linguagens avaliam remotamente
  sem ver as regras.
- A API nativa continua tipada e idiomática do Adonis. Tracking ainda é experimental na spec,
  então o acoplamento fica só no pacote do provider.

## 14. Recursos

Tudo entra; a ordem é a de §15.

- Tipos: booleana, multivariante (string/número/JSON), kill switch.
- Targeting: regras, segmentos, overrides, pré-requisitos, bucketing por atributo.
- Experimentos: pesos, sticky assignment, camadas de exclusão mútua, holdout global, métricas
  de proteção (telescope), SRM.
- Ciclo de vida: flag velha (contador de avaliações), dono/expiração, `ace flags:refs`,
  agendamento e rollout gradual (schedule do durable).
- Ambientes no mesmo store, export/import, `ace flags:promote`, aprovação em duas pessoas,
  audit log.
- Tempo real no frontend via `@adonisjs/transmit`.
- DX: `flags.for(subject)`, middleware de rota, `@flag` no Edge, share no Inertia, `useFlag()`,
  `flags.fake()`, `configure`, `createFlagsTables`, `ace flags:list|set`.
- Retenção e deleção por subject (LGPD).

## 15. Estado

Tudo de §14 está implementado, com testes unitários (SQLite, HTTP real entre control-plane e
tenant, DuckDB/Parquet locais) e de integração (Postgres, Redis e ClickHouse em Docker).

## 16. Decisões tomadas na implementação

- **Timestamps em BIGINT (epoch ms)** em todas as tabelas e eventos: nenhum fuso horário, mesma
  aritmética em Postgres, MySQL, SQLite, DuckDB e ClickHouse.
- **Cursor do relay sem buraco**: ids de auto-incremento são dados antes do commit, então um
  cursor só por id perderia o evento de uma transação lenta. No Postgres o cursor é `(xid8, id)` e
  o relay só lê transações anteriores ao `pg_snapshot_xmin`, o que fecha o buraco exatamente
  (testado). No MySQL há uma janela de segurança (`mysqlSafetyMs`, 10s); o SQLite tem um escritor só.
- **`setEnabled` é o kill switch**, não "servir on". Para flags booleanas existem `turnOn`/`turnOff`.
- **Auditoria ordenada pela versão do ruleset** que cada mudança produziu (determinística).
- **Exposição só em `details/value/enabled/variant`**; `all()` (valores para o browser) não expõe,
  a menos que `expose: true`. Só flags declaradas com `client: true` vão para o browser.
- **Sticky lê `flags_exposures`** (tabela do sink `lucid`), uma consulta por request e só para
  flags de experimento; desligado por padrão.
- **Janela das métricas dentro das expressões de agregação**, não no WHERE: quem não converteu na
  janela continua no denominador (testado nos três backends).
- **Holdout é registrado como exposição** com variante `__holdout__`, para medir o efeito somado.
- **`role`/`dispatcher`/`topology`** seguem `_1x/ROLE-VOCABULARY-SPEC.md`; o loop é `flags:work`.
- **Tenant** manda `x-flags-tenant` em toda requisição; a identidade vem do token verificado.
- **Regex de targeting** limitada (tamanho, quantificador aninhado, backreference, entrada até 4096).
- **Durable**: o registro (`register` + `registerSchedules`, `overlap: 'skip'`) é testado com um
  `WorkflowEngine` real (0.60 e 1.0.0-rc.11, store em memória) disparando o schedule do relay.
- **Flags criadas no console** ficam no ruleset (`FlagDefinition.declaration`); declaração no código
  vence. `flags:types` gera os tipos das flags do console; `strictKeys` recusa chaves não declaradas.
- **Subject do authkit por padrão**: `ctx.authkit.getIdentity()` vira o subject (`sub` como
  targetingKey; email, emailDomain, globalRoles, orgId/orgSlug/orgRole como atributos) e o ator do
  console. Sem authkit, `ctx.auth.user`.
- **Frontends sem Inertia** (`browser` no config, `remoteFlags` no flags-react): cada app monta
  `GET /_flags/token`, que assina (HMAC, 5 min) o mesmo subject do `ctx.flags` — identidade do
  authkit, senão o `subject` do config, senão anônimo — com os `attributes` do servidor. A chave é
  por app+ambiente, derivada do `browser.secret` (default APP_KEY) de quem serve a API; o tenant
  pega a dele no control-plane (`POST /v1/browser-key`, escopo events:write) pela conexão de tenant
  que já tem, então não há segredo novo. A API (`/v1/client/evaluate|stream|events`) roda no
  standalone e no control-plane; deriva a chave de novo a partir de app/env do token. O browser
  guarda o token só em memória. Por quê: o authkit é BFF — o access token fica na sessão do servidor
  e o browser nunca o vê. `userVerifiers.authkit` fica para apps com token próprio (mobile PKCE).
  Atributos do browser entram por baixo e não mudam targetingKey/subjectType. Só flags
  `client: true`, só valores. Exposições do browser são reavaliadas no servidor.
- **`FlagsIdentityProvider`** (`identity` no config): um contrato só, como o user provider do
  @adonisjs/auth — `subject`, `actor`, `authorizeConsole`, `can`. Built-ins `identities.authkit()` e
  `identities.adonisAuth()`; sem authkit a pessoa escreve as regras (Bouncer) e a doc
  "Authentication" guia. Opções explícitas nos configs (`subject`, `authorize`, `actor`) vencem.
