# Plan 18 — Provider « Clawcal » : agent ACP local piloté par Ollama

Intégration de Clawcal (serveur MCP Python maison, dépôt `clawcal`) comme provider
T3 Code via le protocole ACP. Deux volets : (A) ajouter à Clawcal un mode
`clawcal acp` implémentant le rôle *agent* du protocole ; (B) créer côté T3 un
driver mince réutilisant la machinerie ACP existante.

Décisions d'entrée (fermées) : architecture agent ACP ; approbations en v1 ;
backend Ollama seulement en v1 ; conservation du parsing hybride des tool calls,
de la troncature des résultats d'outils et du plafond d'itérations de Clawcal.

Branches de travail : `claude/clawcal-ollama-acp-integration-pzqsqy` (les deux dépôts).

---

## 0. Constats d'exploration qui cadrent le plan

1. **T3 n'implémente aucun handler client `fs/*` ni `terminal/*`.**
   `AcpSessionRuntime` ré-exporte les fonctions d'enregistrement d'`effect-acp`
   (`apps/server/src/provider/acp/AcpSessionRuntime.ts:679-694`) mais aucun
   adaptateur ne les branche ; les `clientCapabilities` envoyées à `initialize`
   sont `fs.readTextFile:false, fs.writeTextFile:false, terminal:false`
   (`AcpSessionRuntime.ts:394-406`). Un appel entrant recevrait `methodNotFound`
   (`packages/effect-acp/src/_internal/shared.ts:29-36`).
   **Décision qui en découle : Clawcal exécute ses propres outils** (comme
   Cursor et Grok). La délégation fs/terminal au client est une évolution v2.
2. **Pas d'adaptateur ACP générique partagé** : Cursor et Grok ont chacun leur
   adaptateur complet ; le partage se fait par briques (`AcpSessionRuntime`,
   `AcpRuntimeModel`, `AcpCoreRuntimeEvents`, `AcpAdapterSupport`). On crée donc
   un `ClawcalAdapter.ts` dédié sur ce modèle.
3. **`session/load` est appelé inconditionnellement** dès qu'un `resumeSessionId`
   est fourni (`AcpSessionRuntime.ts:547`), sans consulter
   `agentCapabilities.loadSession`. Clawcal ne persistant pas l'historique en v1,
   l'adaptateur T3 ne doit jamais fournir de `resumeSessionId` (reprise = session
   neuve).
4. **Il n'y a pas de système i18n dans t3code** (`PLAN-QUEBEC.md:14`) : les
   chaînes fr-CA sont écrites en dur dans les sources (UI et messages de probe
   serveur). « i18n fr-CA » = libellés français directement dans le code,
   vérifiés visuellement (skill `t3-verif-fr`).
5. `ProviderDriverKind` est un **slug ouvert** (`contracts/src/providerInstance.ts:58-71`),
   pas une enum à étendre ; mais plusieurs cartes `Partial<Record<...>>`
   (`contracts/src/model.ts:130-211`), l'union `TextGenerationProvider`
   (`textGeneration/TextGeneration.ts:10`) et le miroir legacy
   `ServerSettings.providers` (`contracts/src/settings.ts:396-402`) doivent
   recevoir une entrée `clawcal` — sans le miroir, l'instance n'est **pas**
   auto-créée à l'hydration (`Layers/ProviderInstanceRegistryHydration.ts:91-95`).
6. Côté T3, **seul `stopReason === "cancelled"` change l'état du turn**
   (`CursorAdapter.ts:1032-1044`, idem Grok) ; tout le reste donne
   `turn.completed` état `completed` avec le stopReason brut en payload.
   Énumération ACP : `end_turn | max_tokens | max_turn_requests | refusal | cancelled`.
7. Pour les permissions, **Cursor renvoie des `optionId` legacy en dur**
   (`allow-once`…) tandis que **Grok résout le vrai `optionId` par `kind`**
   (`GrokAdapter.ts:182-194`) — on suit le modèle Grok. L'auto-approbation ne se
   déclenche qu'en `full-access` (`selectAutoApprovedPermissionOption`) ;
   `approval-required` et `auto-accept-edits` passent par le panneau (existant).
8. Les tests d'adaptateur utilisent un **vrai agent ACP factice**
   (`apps/server/scripts/acp-mock-agent.ts`) spawné via un wrapper shell qui
   remplace le `binaryPath` (`CursorAdapter.test.ts:44-83`) — patron à réutiliser.

---

## 1. Volet A — clawcal : le mode `clawcal acp`

Nouveau paquet `src/acp/`, zéro changement de comportement des modes MCP
http/stdio existants. Style maison conservé : dataclasses gelées, outils qui
retournent des chaînes d'erreur, logs JSONL, TDD.

### 1.1 Fichiers

```
src/acp/__init__.py
src/acp/jsonrpc.py       # framing ndjson + JSON-RPC 2.0 bidirectionnel (Futures par id)
src/acp/protocol.py      # dataclasses gelées des messages ACP v1 utilisés
src/acp/session.py       # AcpSession : historique messages, permissions mémorisées,
                         # tâche de prompt active, cwd, modèle courant
src/acp/agent_events.py  # événements internes streamés par la boucle (dataclasses gelées)
src/acp/runner.py        # boucle agent streamée (générateur async d'AgentEvent)
src/acp/stream_filter.py # XmlToolCallStreamFilter (rétention <tool_call> en flux)
src/acp/server.py        # AcpAgentServer : dispatch des méthodes, cycle de vie
tests/acp/…
```

Point d'entrée : sous-commande `clawcal acp` dans `src/server.py:main` (argparse
subparser ; les flags `--transport http|stdio` existants restent intacts).
Options : `--ollama-url`, `--model`, `--max-iterations`, `--num-ctx`,
`--auto-approve` (tests manuels hors T3). Le mode ACP force le backend Ollama
(pas de Gemini/Zen ni de chaîne de repli — périmètre v1). Ajouter aussi un flag
global `--version` (requis par la sonde de disponibilité T3).

### 1.2 Transport ndjson et pureté de stdout

- stdin/stdout via asyncio streams, un objet JSON par ligne.
- **stdout est réservé au protocole** : en mode acp, le logging console est
  reconfiguré vers stderr ; les JSONL d'observabilité (`~/.clawcal/logs/`)
  restent des fichiers. Test dédié : tout ce que le sous-processus écrit sur
  stdout doit être du JSON-RPC parsable.
- `jsonrpc.py` gère les deux sens : requêtes entrantes (`initialize`,
  `session/new`, `session/prompt`, `session/set_model`), notifications entrantes
  (`session/cancel`), requêtes sortantes (`session/request_permission`, réponse
  attendue via Future), notifications sortantes (`session/update`).

### 1.3 Méthodes et machine à états de session

- `initialize` → `{protocolVersion: 1, agentCapabilities: {loadSession: false},
  authMethods: []}`. Répond instantanément (aucun appel Ollama).
- `session/new {cwd, mcpServers}` → crée `AcpSession` (uuid), mémorise `cwd` ;
  `models` renseigné en best-effort depuis `GET {ollama}/api/tags` (timeout
  court ; si Ollama est injoignable la réponse part sans `models`, l'erreur ne
  surgit qu'au premier prompt).
- `session/prompt {sessionId, prompt}` → ContentBlocks texte concaténés en
  message `user` ; **l'historique `messages` vit dans `AcpSession`**
  (multi-tours) ; exécution sérialisée par un verrou global (philosophie
  TaskManager) avec `os.chdir(cwd)` autour du run ; la boucle tourne dans une
  `asyncio.Task` suivie par la session ; réponse finale `{stopReason}`.
- `session/cancel` (notification) → `task.cancel()` ; le handler du prompt
  capture `CancelledError` → répond `{stopReason: "cancelled"}`. L'annulation
  fonctionne pendant un appel LLM (l'annulation de la tâche avorte la requête
  httpx) et pendant un outil (correctif `bash.py` : `except CancelledError:
  proc.kill(); raise`).
- `session/set_model {sessionId, modelId}` → change le modèle de la session
  (validé contre `/api/tags`).
- `session/load` → erreur `method not found` (cohérent avec `loadSession: false`).
- États : `idle → prompting → awaiting_permission → prompting → idle` ;
  `cancel` possible dans tous les états actifs.

### 1.4 La boucle streamée (`runner.py`)

Refactor doux de `Agent.run()` (`src/agent.py:59-137`) : extraire la boucle en
générateur asynchrone `run_stream(messages) -> AsyncIterator[AgentEvent]`
émettant :

- `TextChunk(text)` — deltas assistant ;
- `ToolCallStarted(id, name, arguments)` / `ToolCallFinished(id, status, output)` ;
- `TurnDone(stop_reason, final_text)`.

`Agent.run()` devient un consommateur de `run_stream` (les tests actuels restent
verts). Conservés tels quels : plafond `max_iterations` (→ stopReason
`max_turn_requests`), troncature `tool_result_max_chars` (32 000),
collector/observabilité, system prompt.

Mapping vers ACP dans `acp/server.py` :
`TextChunk` → `session/update agent_message_chunk` ; `ToolCallStarted` →
`tool_call` (status `in_progress`, `kind` mappé, `rawInput` = arguments) ;
`ToolCallFinished` → `tool_call_update` (`completed`/`failed` + contenu texte
tronqué).

Mapping outil → `kind` ACP (déterminant côté T3 : types d'items canoniques et
types d'approbation, `AcpCoreRuntimeEvents.ts:32-61`) :

| outil clawcal | kind ACP |
|---|---|
| read_file, analyze_image | read |
| write_file, edit_file | edit |
| bash | execute |
| grep_tool, glob_tool, list_directory | search |
| mcp_call | other |

### 1.5 Streaming LLM et parsing hybride en flux

Ajouter `LlmClient.chat_stream(messages, tools)` (`stream: true` sur
`/api/chat`, ndjson) :

- deltas `message.content` émis au fil de l'eau ;
- `message.tool_calls` natifs collectés dans le flux (Ollama les livre en
  streaming) ;
- usage extrait du chunk final (`done: true`), mêmes calculs que
  `parse_response` (`src/llm_client.py:92-107`).

**Parsing hybride conservé en flux** : les deltas texte passent par
`XmlToolCallStreamFilter`, un tampon de rétention qui retient toute fin de
chunk pouvant préfixer `<tool_call>` ; balise confirmée → le contenu jusqu'à
`</tool_call>` est consommé sans être émis et parsé comme tool call (mêmes
règles JSON + warnings que `parse_response`) ; fausse alerte → le tampon est
relâché. Filtre testé isolément (balises coupées en plein milieu, JSON invalide,
multiples tool calls, texte avant/après). `parse_response()` non-stream reste
inchangé pour les autres modes.

### 1.6 Permissions (`session/request_permission`)

- Outils sensibles : `bash`, `write_file`, `edit_file`, `mcp_call`.
  Lecture/recherche : jamais de permission.
- Avant exécution : requête avec le toolCall courant et options
  `[{optionId:"allow-once", kind:"allow_once"}, {optionId:"allow-always",
  kind:"allow_always"}, {optionId:"reject-once", kind:"reject_once"}]`.
- `allow_always` → mémorisé par `(session, nom d'outil)` dans `AcpSession`.
- Rejet → l'outil n'est **pas** exécuté ; résultat outil = chaîne d'erreur
  « Permission refusée par l'utilisateur » (convention clawcal),
  `tool_call_update` status `failed` ; la boucle continue.
- Outcome `cancelled` (interruption pendant l'attente) → stopReason `cancelled`.
- `--auto-approve` court-circuite tout (usage standalone/tests manuels).

Côté T3, rien à inventer : `full-access` auto-approuve côté serveur,
`approval-required`/`auto-accept-edits` passent par le panneau (constat 7).

### 1.7 Observabilité

`MetricsCollector` par prompt (session_id = sessionId ACP), `log_session` /
`log_trace` inchangés. Aucun nouveau type d'événement nécessaire en v1.

### 1.8 Tests clawcal

- **Unitaires** : framing jsonrpc ; `XmlToolCallStreamFilter` ; `run_stream`
  avec `FakeLlmClient` étendu d'un `chat_stream` factice ; permissions (fake
  client qui répond accept/reject/always/cancel) ; annulation (cancel pendant un
  fake LLM lent, pendant un fake outil lent).
- **Intégration** : spawn de `python -m src.server acp` en sous-processus,
  dialogue ndjson complet piloté par pytest (initialize → session/new → prompt →
  updates → réponse), avec un **fake serveur HTTP Ollama** local — aucun besoin
  d'Ollama réel en CI. Test de pureté stdout.
- Vérification : `python -m pytest -v`.

---

## 2. Volet B — t3code : le driver Clawcal

Méthode maison respectée (`.plans/17-claude-agent.md` : contrats d'abord,
adaptateur ensuite, jamais de contournement de l'OrchestrationEngine,
`resumeCursor` opaque propriété de l'adaptateur).

### 2.1 Contrats (`packages/contracts` — schema-only)

- `settings.ts` : `ClawcalSettings = makeProviderSettingsSchema(...)` — champs :
  `enabled` (défaut `false`, opt-in), `binaryPath` (défaut `"clawcal"`),
  `serverUrl` (défaut `""`, placeholder `http://127.0.0.1:11434` — patron
  `OpenCodeSettings.serverUrl`, `settings.ts:324-334`), `customModels` (masqué).
  Ordre form : `["binaryPath", "serverUrl"]`. Ajouter l'entrée `clawcal` au
  miroir `ServerSettings.providers` (`:396-402`) et à
  `ServerSettingsPatch.providers` (`:523-525`) — indispensable à l'hydration
  (constat 5).
- `model.ts` : `DEFAULT_MODEL_BY_PROVIDER.clawcal = "qwen3:14b"`,
  `PROVIDER_DISPLAY_NAMES.clawcal = "Clawcal"`,
  `DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.clawcal = "qwen3:14b"`.

### 2.2 `provider/acp/ClawcalAcpSupport.ts`

`buildClawcalAcpSpawnInput(settings)` → `{command: binaryPath || "clawcal",
args: ["acp", ...(serverUrl ? ["--ollama-url", serverUrl] : [])], env}` ; pas
d'`authMethodId` ; `makeClawcalAcpRuntime` = `AcpSessionRuntime.layer` sans
extension, `clientCapabilities` par défaut (fs/terminal `false`), et **jamais de
`resumeSessionId`** (constat 3).

### 2.3 `provider/Layers/ClawcalAdapter.ts` (+ `Services/ClawcalAdapter.ts`)

Calqué sur la **structure de CursorAdapter** (gestion sessions/turns/verrous par
thread, boucle de drain `acp.getEvents()` → fabriques `AcpCoreRuntimeEvents`,
`mapAcpToAdapterError`), **sans aucune extension propriétaire** — pas non plus
de la machinerie de settlement Grok (Clawcal répond fiablement à
`session/prompt`). Permissions sur le modèle **Grok** : résolution du vrai
`optionId` par `kind` (`selectPermissionOptionId`), auto-approbation
`full-access` via `selectAutoApprovedPermissionOption`. Sélection de modèle via
`setSessionModel` ACP quand `modelSelection` change. `resumeCursor` opaque
`{schemaVersion: 1, sessionId}` émis pour compatibilité future mais jamais
rejoué en v1. `interruptTurn` : règle les approbations pendantes en `cancelled`
puis `acp.cancel` (patron `CursorAdapter.ts:1060-1072`).

### 2.4 `provider/Layers/ClawcalProvider.ts` — snapshot de disponibilité

`checkClawcalProviderStatus` :
1. instance désactivée → message fr « Clawcal est désactivé dans les paramètres
   de T3 Code. » ;
2. `clawcal --version` (timeout 4 s, `parseGenericCliVersion`) — binaire absent
   → `error` avec instruction d'installation ;
3. `GET {serverUrl||défaut}/api/tags` (HttpClient Effect, timeout court) →
   catalogue `ServerProviderModel[]` (`slug` = nom du tag Ollama) ; Ollama
   injoignable → `warning` mentionnant l'URL (patron
   `formatOpenCodeProbeError`).

Monté via `makeManagedServerProvider` (refresh 5 min) ;
`maintenanceCapabilities` : manuel seulement (comme Grok). Fusion
`customModels` via `providerModelsFromSettings`.

### 2.5 `textGeneration/ClawcalTextGeneration.ts`

Patron `GrokTextGeneration` : runtime ACP éphémère, prompts partagés
(`TextGenerationPrompts.ts`), collecte des `agent_message_chunk`,
`extractJsonObject` + `Schema.fromJsonString`, timeout 180 s. Étendre l'union
`TextGenerationProvider` (`TextGeneration.ts:10`) avec `"clawcal"`.

### 2.6 Enregistrement

`Drivers/ClawcalDriver.ts` (patron `GrokDriver.ts:85-161`) : `configSchema`
ClawcalSettings, `defaultConfig`, `continuationIdentity` par défaut, `create()`
= adapter + textGeneration + snapshot. Ajout à `BUILT_IN_DRIVERS` et
`BuiltInDriversEnv` (`builtInDrivers.ts:35-53`).

### 2.7 UI + fr-CA

- `apps/web/src/components/Icons.tsx` : `ClawcalIcon` (SVG monochrome
  `currentColor` — pince de homard stylisée, gabarit de `GrokIcon:202`).
- `settings/providerDriverMeta.ts` : `{value: "clawcal", label: "Clawcal",
  icon: ClawcalIcon, settingsSchema: ClawcalSettings, badgeLabel: "Local"}`.
- `chat/providerIconUtils.ts` ; `session-logic.ts` `PROVIDER_OPTIONS`
  (`{value: "clawcal", label: "Clawcal", available: true,
  pickerSidebarBadge: "new"}`) ; vérifier `composerDraftStore.ts`,
  `lib/contextWindow.ts`, `settings/ProviderModelsSection.tsx`.
- Chaînes serveur fr-CA en dur (messages de probe, cf. 2.4). Vérification
  visuelle en fin de jalon 7 via le skill `t3-verif-fr`.

### 2.8 Tests t3code

- `Layers/ClawcalAdapter.test.ts` : réutilise `scripts/acp-mock-agent.ts` +
  wrapper shell (patron `CursorAdapter.test.ts:44-83`) — scénarios : turn texte
  simple, tool_call/tool_call_update, permission accept/decline +
  auto-approbation full-access, cancel en vol, crash du processus.
- `Layers/ClawcalProvider.test.ts` : faux binaire (--version) + faux serveur
  HTTP `/api/tags` (patron OpenCodeProvider.test.ts).
- `acp/ClawcalAcpSupport.test.ts` : construction du spawn input.
- Vérifications obligatoires : `vp check` **et** `vp run typecheck` (AGENTS.md:5).

---

## 3. Ordre de livraison — jalons incrémentaux testables

| # | Dépôt | Livrable | Vérification |
|---|---|---|---|
| 1 | clawcal | Squelette ACP « echo » : jsonrpc ndjson, `initialize`, `session/new`, `session/prompt` qui renvoie le texte reçu en un `agent_message_chunk` + `end_turn`, `session/cancel`. Test d'intégration stdio + test de pureté stdout. | `python -m pytest -v` |
| 2 | clawcal | Boucle Ollama streamée **sans outils** : `chat_stream`, runner `TextChunk`/`TurnDone`, historique multi-tours, annulation pendant l'appel LLM. Fake Ollama HTTP dans les tests. | pytest + smoke manuel `clawcal acp` (script de dialogue ndjson) |
| 3 | clawcal | Outils + `tool_call`/`tool_call_update` : `XmlToolCallStreamFilter`, mapping kinds, troncature, `max_turn_requests`, annulation pendant un outil (kill bash). | pytest |
| 4 | clawcal | Permissions : `session/request_permission`, mémoire `allow_always` par session, rejet → chaîne d'erreur, outcome `cancelled`, `--auto-approve`. | pytest |
| 5 | clawcal | Modèles + finitions : `models` dans `session/new` via `/api/tags`, `session/set_model`, `--version`, doc du mode acp (README/CLAUDE.md). | pytest complet |
| 6 | t3code | Contrats + support + adaptateur + snapshot + textGeneration + enregistrement (2.1→2.6) avec leurs tests. | `vp check`, `vp run typecheck`, `vp test` ciblé |
| 7 | t3code | UI + fr-CA + bout en bout : providerDriverMeta, icône, picker ; parcours réel t3 ↔ clawcal ↔ Ollama (skill `t3-dev`), vérif fr (skill `t3-verif-fr`). | `vp check`, `vp run typecheck`, parcours manuel |

Chaque jalon = commits conventionnels (`feat:`/`test:`/`docs:`) poussés sur la
branche désignée du dépôt concerné. Jalons 1-5 : TDD (test rouge d'abord),
conformément aux conventions clawcal.

---

## 4. Risques et mitigations

- **R1 — Modèles Ollama sans tool calling fiable.** Parsing hybride conservé
  (natif → XML → texte). Risque résiduel spécifique au streaming : fuite de
  fragments `<tool_call>` dans le texte affiché → filtre de rétention dédié et
  testé (balises coupées entre chunks). Petit modèle qui n'appelle jamais
  d'outil → réponse en texte pur, comportement dégradé mais propre. Documenter
  les modèles recommandés (qwen3, llama3.1+).
- **R2 — Fenêtres de contexte courtes.** Ollama tronque silencieusement
  (num_ctx faible par défaut) : exposer `--num-ctx`, conserver la troncature
  32 000 caractères des résultats d'outils et le plafond d'itérations. Limitation
  v1 assumée : pas de compaction de l'historique multi-tours (candidate v2 :
  résumé glissant).
- **R3 — Latence locale.** Premier prompt = chargement du modèle en mémoire
  (potentiellement > 30 s). Côté T3, `session/prompt` n'a pas de timeout (seul
  `session/load` en a un, 90 s, non utilisé ici) ; `initialize`/`session/new`
  répondent instantanément (le `/api/tags` de session/new est best-effort avec
  timeout court) ; textGeneration a 180 s de timeout — suffisant, titres
  possiblement lents.
- **R4 — Mapping des stopReason.** T3 ne distingue que `cancelled` ; Clawcal
  n'émet que des valeurs de l'énumération ACP : `end_turn`,
  `max_turn_requests`, `cancelled` (`max_tokens` non détectable en v1). Un
  `max_turn_requests` s'affichera comme turn complété avec le message final
  « Stopped: reached max iterations » — visible et acceptable.
- **R5 — Reprise de session (resumeCursor).** Clawcal ne persiste pas
  l'historique : `loadSession: false`, et comme T3 appelle `session/load`
  inconditionnellement quand un `resumeSessionId` existe, l'adaptateur Clawcal
  n'en fournit jamais → après redémarrage de T3 ou de l'instance, session neuve
  (perte du contexte de conversation, documentée comme limitation v1). v2 :
  persistance JSONL des `messages` par sessionId + `session/load` avec replay
  des updates.
- **R6 — Pureté de stdout.** Tout `print` parasite casse le ndjson : logging
  redirigé vers stderr en mode acp + test automatique de pureté du flux.
- **R7 — Concurrence et cwd global.** Les outils clawcal travaillent en relatif
  au cwd du processus (`os.chdir`) : prompts sérialisés par verrou global (une
  exécution à la fois, aligné sur la philosophie TaskManager). En pratique T3
  spawne **un processus clawcal par session ACP**, donc pas de contention réelle.
