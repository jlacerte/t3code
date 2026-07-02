# La boucle agentique de T3 Code — rapport technique

Ce rapport décrit, de bout en bout, comment fonctionne la « boucle agentique » de T3 Code :
ce qui se passe entre le moment où l'utilisateur envoie un message et le moment où le tour
(*turn*) est terminé, checkpoint capturé et interface mise à jour. Toutes les affirmations
sont référencées vers le code source (`fichier:ligne`, état du dépôt au 2026-07-02).

## Table des matières

1. [Résumé](#1-résumé)
2. [Positionnement : où vit réellement la boucle](#2-positionnement--où-vit-réellement-la-boucle)
3. [Architecture d'ensemble](#3-architecture-densemble)
4. [Le socle : event sourcing et CQRS](#4-le-socle--event-sourcing-et-cqrs)
5. [Anatomie d'un turn, étape par étape](#5-anatomie-dun-turn-étape-par-étape)
6. [La couche provider : piloter des agents hétérogènes](#6-la-couche-provider--piloter-des-agents-hétérogènes)
7. [Approbations d'outils et modes runtime (human-in-the-loop)](#7-approbations-doutils-et-modes-runtime-human-in-the-loop)
8. [Streaming du texte assistant](#8-streaming-du-texte-assistant)
9. [Checkpoints et diffs de turn](#9-checkpoints-et-diffs-de-turn)
10. [Fin de turn : complétion, interruption, quiescence](#10-fin-de-turn--complétion-interruption-quiescence)
11. [Côté client : transport, réduction d'état, interface](#11-côté-client--transport-réduction-détat-interface)
12. [Garanties de robustesse](#12-garanties-de-robustesse)
13. [Index des fichiers de référence](#13-index-des-fichiers-de-référence)

---

## 1. Résumé

T3 Code est une interface web/desktop pour agents de codage (Codex, Claude, Cursor, Grok,
OpenCode — `README.md:3`). La boucle « raisonnement → appel d'outil → résultat → raisonnement »
proprement dite est exécutée par le CLI de chaque fournisseur ; T3 Code, lui, implémente la
**boucle d'orchestration** qui l'entoure :

- un **modèle événementiel** (event sourcing / CQRS) où toute action est une *commande* qui
  produit des *événements de domaine* persistés, projetés et diffusés
  ([`decider.ts`](../../apps/server/src/orchestration/decider.ts),
  [`projector.ts`](../../apps/server/src/orchestration/projector.ts)) ;
- des **réacteurs** qui traduisent ces événements en appels au provider (aller) et les
  événements natifs du provider en nouvelles commandes (retour), formant une boucle fermée
  ([`ProviderCommandReactor.ts`](../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts),
  [`ProviderRuntimeIngestion.ts`](../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts)) ;
- une **couche provider** qui normalise cinq protocoles différents (JSON-RPC Codex, SDK Claude,
  ACP, runtime OpenCode) vers un modèle d'événements canonique unique,
  `ProviderRuntimeEvent` (`packages/contracts/src/providerRuntime.ts:967`) ;
- un mécanisme d'**approbations** human-in-the-loop, des **checkpoints git** par turn, et un
  client qui reconstruit l'état par réduction d'un flux d'événements séquencés.

Le cycle complet d'un turn :

```
Utilisateur → thread.turn.start → OrchestrationEngine (decider → events → projections → PubSub)
     → ProviderCommandReactor → ProviderService.sendTurn → agent externe (CLI)
     → streamEvents (ProviderRuntimeEvent) → ProviderRuntimeIngestion → nouvelles commandes
     → OrchestrationEngine → … (boucle) … → turn.completed → CheckpointReactor (diff git)
     → événements poussés au client → réduction d'état → interface
```

---

## 2. Positionnement : où vit réellement la boucle

Il faut distinguer deux « boucles agentiques » :

1. **La boucle LLM interne** (choisir un outil, l'exécuter, relire le résultat, recommencer).
   Elle vit dans les binaires des providers : `codex app-server`, Claude Code (via le Claude
   Agent SDK), `cursor-agent`, etc. T3 Code ne l'implémente pas et n'y touche pas.
2. **La boucle d'orchestration T3** : démarrer/reprendre des sessions, envoyer les prompts,
   ingérer le flux d'événements de l'agent, gérer les approbations d'outils, capturer les
   checkpoints, projeter l'état vers l'interface. C'est l'objet de ce rapport.

Cette séparation est posée dès la doc d'architecture : le serveur Node « wraps `codex
app-server` (JSON-RPC over stdio) and serves a React web app »
(`docs/architecture/overview.md:3`), et le glossaire du projet définit le *turn* comme « a
single user-to-assistant work cycle inside a thread. It starts with user input and ends when
follow-up work like checkpointing settles » (`docs/reference/encyclopedia.md:37`).

Concepts durables (voir `docs/reference/encyclopedia.md`) :

| Terme | Définition | Réf. |
|---|---|---|
| **Thread** | unité durable de conversation + historique de workspace | `encyclopedia.md:33` |
| **Turn** | un cycle utilisateur→assistant, clôturé quand le suivi (checkpoint) est réglé | `encyclopedia.md:37` |
| **Activity** | élément de journal visible (approbations, outils, erreurs) | `encyclopedia.md:41` |
| **Reactor** | service à effets de bord réagissant aux événements | `encyclopedia.md:79` |
| **Receipt** | signal runtime typé de jalon asynchrone | `encyclopedia.md:83` |
| **Quiesced** | « tout le travail de suivi du turn est retombé au repos » | `encyclopedia.md:88` |

---

## 3. Architecture d'ensemble

```
┌──────────────────────────────────────────────┐
│ Client (apps/web + packages/client-runtime)  │
│  RpcClient Effect sur WebSocket              │
│  dispatchCommand / subscribeThread           │
│  threadReducer (réduction d'événements)      │
└──────────────┬───────────────────────────────┘
               │ WebSocket (RPC Effect, ndjson)
┌──────────────▼───────────────────────────────┐
│ Serveur (apps/server)                        │
│  http.ts → Normalizer → OrchestrationEngine  │
│    decider (pur) + event store + projections │
│    PubSub d'événements de domaine            │
│  Réacteurs :                                 │
│    ProviderCommandReactor  (domaine→provider)│
│    ProviderRuntimeIngestion(provider→domaine)│
│    CheckpointReactor       (git/diffs)       │
│  ProviderService → adapters par instance     │
└──────────────┬───────────────────────────────┘
               │ stdio JSON-RPC / SDK / HTTP
┌──────────────▼───────────────────────────────┐
│ Agents externes : codex app-server, Claude   │
│ Agent SDK, cursor-agent (ACP), grok (ACP),   │
│ OpenCode                                     │
└──────────────────────────────────────────────┘
```

Deux conventions structurent `apps/server/src/orchestration` :

- **`Services/*.ts`** : interfaces pures (tags `Context.Service`), p. ex.
  `Services/OrchestrationEngine.ts:24-54` (`dispatch`, `readEvents`, `streamDomainEvents`) ;
- **`Layers/*.ts`** : implémentations `Layer.effect`, p. ex.
  `Layers/OrchestrationEngine.ts:79-333`.

Le câblage d'infrastructure est dans `orchestration/runtimeLayer.ts:24`
(`OrchestrationLayerLive`), et les réacteurs sont démarrés en séquence par
`Layers/OrchestrationReactor.ts:21-27` : `providerRuntimeIngestion`,
`providerCommandReactor`, `checkpointReactor`, `threadDeletionReactor`,
`agentAwarenessRelay`.

---

## 4. Le socle : event sourcing et CQRS

### 4.1 Commandes → événements : le décideur

L'unique porte d'entrée d'écriture est l'API `orchestration` (`dispatch` + `snapshot`,
`apps/server/src/orchestration/http.ts:26-57`). Chaque commande cliente passe d'abord par
`normalizeDispatchCommand` (`http.ts:46`, implémentation `Normalizer.ts:16`) qui résout le
`workspaceRoot` (`Normalizer.ts:23-66`) et matérialise les pièces jointes image sur disque
avec validation taille/MIME (`Normalizer.ts:72-135`), puis atteint
`orchestrationEngine.dispatch` (`http.ts:49`).

`decideOrchestrationCommand` (`orchestration/decider.ts:96`) est une **fonction pure** :
`{ command, readModel }` → un ou plusieurs `PlannedOrchestrationEvent` (`decider.ts:56-60`).
Chaque événement reçoit une base commune via `withEventBase` (`decider.ts:26-54`) :
`eventId` (UUID), `aggregateKind`/`aggregateId`, `occurredAt`, `commandId`,
`causationEventId`, `correlationId`, `metadata`. Les invariants (thread existant, non
archivé…) viennent de `commandInvariants.ts` (importés `decider.ts:13-21`) ; une violation
lève `OrchestrationCommandInvariantError` (`orchestration/Errors.ts:30`).

Commandes du cycle de vie d'un turn (le `switch` complet démarre à `decider.ts:107`) :

| Commande | Événement(s) produits | Réf. decider |
|---|---|---|
| `thread.turn.start` | `thread.message-sent` (user) **puis** `thread.turn-start-requested` (causé par le message) | `decider.ts:389-462` |
| `thread.turn.interrupt` | `thread.turn-interrupt-requested` | `decider.ts:464-484` |
| `thread.approval.respond` | `thread.approval-response-requested` | `decider.ts:486-510` |
| `thread.user-input.respond` | `thread.user-input-response-requested` | `decider.ts:512-536` |
| `thread.checkpoint.revert` | `thread.checkpoint-revert-requested` | `decider.ts:538-558` |
| `thread.session.stop` | `thread.session-stop-requested` | `decider.ts:560-579` |
| `thread.session.set` (interne) | `thread.session-set` | `decider.ts:581-601` |
| `thread.message.assistant.delta` (interne) | `thread.message-sent` (assistant, `streaming: true`) | `decider.ts:603-628` |
| `thread.message.assistant.complete` (interne) | `thread.message-sent` (assistant, `streaming: false`) | `decider.ts:630-655` |
| `thread.proposed-plan.upsert` (interne) | `thread.proposed-plan-upserted` | `decider.ts:657-676` |
| `thread.turn.diff.complete` (interne) | `thread.turn-diff-completed` | `decider.ts:678-703` |
| `thread.activity.append` (interne) | `thread.activity-appended` | `decider.ts:726-754` |

Le contrat client/serveur distingue explicitement les commandes dispatchables par le client
(`DispatchableClientOrchestrationCommand`, `packages/contracts/src/orchestration.ts:660-679`)
des commandes internes émises par le serveur (`InternalOrchestrationCommand`,
`orchestration.ts:766-775`).

### 4.2 L'OrchestrationEngine : sérialisation, persistance, publication

`Layers/OrchestrationEngine.ts` est la **seule autorité d'écriture** de l'event store.
Mécanique :

- un *read model* de commande en mémoire (`OrchestrationEngine.ts:88`), reconstruit au
  démarrage après bootstrap des projections SQL (`OrchestrationEngine.ts:300-301`) ;
- une **file sérialisée** `commandQueue` (`OrchestrationEngine.ts:90`) drainée par un worker
  unique en `Effect.forever` (`OrchestrationEngine.ts:303-304`) — les commandes sont
  traitées strictement une à une ;
- `dispatch` (`OrchestrationEngine.ts:312-321`) enfile la commande avec un `Deferred` et
  attend le résultat `{ sequence }`.

Pour chaque commande, `processEnvelope` (`OrchestrationEngine.ts:105-298`) :

1. **déduplique** par `commandId` via le dépôt de reçus de commande
   (`OrchestrationEngine.ts:138-151`) — une commande déjà acceptée renvoie sa séquence, une
   commande déjà rejetée lève `OrchestrationCommandPreviouslyRejectedError` ;
2. **décide** (`OrchestrationEngine.ts:153-167`) ;
3. **persiste en transaction SQL** (`OrchestrationEngine.ts:169-213`) : `eventStore.append`
   (attribution de la `sequence` monotone), projection mémoire (`projectEvent`), projection
   SQL (`projectionPipeline.projectEvent`, `OrchestrationEngine.ts:178`), reçu `accepted`
   (`OrchestrationEngine.ts:190-198`) ;
4. **publie** chaque événement sur un `PubSub` après commit
   (`OrchestrationEngine.ts:216-217`) — c'est la source de `streamDomainEvents`
   (`OrchestrationEngine.ts:329-331`), qui crée une souscription indépendante par
   consommateur ;
5. en cas d'échec partiel, `reconcileReadModelAfterDispatchFailure`
   (`OrchestrationEngine.ts:113-126`) rejoue les événements réellement persistés.

### 4.3 Les deux projections

1. **Read model mémoire** (pour le décideur) : `projector.ts` — `projectEvent(model, event)`
   (`projector.ts:190`), fonction pure qui applique chaque événement au
   `OrchestrationReadModel` (le `switch` est à `projector.ts:200`), en décodant les payloads
   via les schémas des contrats (`projector.ts:72-81` ; `Schemas.ts:26-52` n'est qu'une
   surface d'alias sans logique).
2. **Projections SQL** (pour les lectures) : `Layers/ProjectionPipeline.ts` —
   `makeOrchestrationProjectionPipeline` (`ProjectionPipeline.ts:470`) compose neuf
   projecteurs indépendants (`ProjectionPipeline.ts:1462-1499`) : `projects`,
   `threadMessages`, `threadProposedPlans`, `threadActivities`, `threadSessions`,
   `threadTurns`, `checkpoints`, `pendingApprovals`, `threads`. Chacun garde un curseur de
   séquence persistant (`ProjectionPipeline.ts:1511-1518`) permettant le replay au
   démarrage (`bootstrapProjector`, `ProjectionPipeline.ts:1534-1548`).

Les événements eux-mêmes sont contractualisés dans
`packages/contracts/src/orchestration.ts` : types (`OrchestrationEventType`,
`orchestration.ts:783-807`), enveloppe séquencée (`EventBaseFields`,
`orchestration.ts:989-999`), union complète (`OrchestrationEvent`,
`orchestration.ts:1001-1113`).

---

## 5. Anatomie d'un turn, étape par étape

### 5.1 Aller : du clic à l'agent

1. **Client** : l'envoi construit une commande `thread.turn.start` (`startThreadTurn`,
   `packages/client-runtime/src/operations/commands.ts:189-199`) avec un `commandId` UUID
   généré côté client (`commands.ts:55-63`), et l'envoie par l'unique méthode d'écriture
   `dispatchCommand` (`commands.ts:78-80`). Le schéma de la commande —
   message utilisateur, `modelSelection`, `runtimeMode`, `interactionMode` — est
   `ThreadTurnStartCommand` (`packages/contracts/src/orchestration.ts:579-598`).
2. **Engine** : le décideur émet *deux* événements — le message utilisateur
   (`thread.message-sent`) puis l'intention `thread.turn-start-requested` dont le
   `causationEventId` pointe sur le message (`decider.ts:389-462`). Ils sont persistés,
   projetés et publiés (§4.2).
3. **ProviderCommandReactor** : ce réacteur souscrit à `streamDomainEvents`, filtre six
   types d'événements « d'intention » (`ProviderCommandReactor.ts:1064-1075` ; union
   `ProviderIntentEvent`, `ProviderCommandReactor.ts:47-58`) et les traite en série via un
   worker drainable (`ProviderCommandReactor.ts:1061`). Pour
   `thread.turn-start-requested`, `processTurnStartRequested`
   (`ProviderCommandReactor.ts:747-861`) :
   - déduplique par clé de turn (`ProviderCommandReactor.ts:750-753`) ;
   - au premier turn d'un thread, déclenche la génération de titre et de nom de branche
     (`ProviderCommandReactor.ts:773-802`) ;
   - garantit une session provider vivante via `ensureSessionForThread`
     (`ProviderCommandReactor.ts:352-584`) — démarrage, reprise ou redémarrage si le
     modèle, le mode runtime ou le répertoire de travail a changé ;
   - appelle enfin `providerService.sendTurn` dans une fibre forkée
     (`ProviderCommandReactor.ts:858-860`).
4. **ProviderService** : route l'appel vers l'adaptateur de l'instance liée au thread
   (`ProviderAdapterRegistry.getByInstance`,
   `provider/Layers/ProviderService.ts:592, 454, 367`), persiste le lien thread→instance
   (`ProviderSessionDirectory`) et sait reprendre une session depuis un `resumeCursor`
   persisté (`recoverSessionForThread`, `ProviderService.ts:355-438`).
5. **Agent externe** : l'adaptateur transmet le prompt au processus/SDK du provider —
   `turn/start` en JSON-RPC pour Codex (`CodexSessionRuntime.ts:1290`), `session/prompt` en
   ACP (`AcpSessionRuntime.ts:707-748`), etc. La boucle LLM interne de l'agent démarre.

### 5.2 Retour : de l'agent à l'état

6. **Flux canonique** : chaque adaptateur publie ses événements normalisés
   (`ProviderRuntimeEvent`, §6.3) sur son `streamEvents`
   (`provider/Services/ProviderAdapter.ts:125`) ; `ProviderService` les agrège dans un
   `PubSub` unique corrélé par instance (`ProviderService.ts:182-200, 284-298`).
7. **ProviderRuntimeIngestion** : la voie de retour de la boucle. Ce réacteur consomme
   `providerService.streamEvents` (`ProviderRuntimeIngestion.ts:1698`) et retraduit chaque
   événement runtime en **commandes** d'orchestration dans `processRuntimeEvent`
   (`ProviderRuntimeIngestion.ts:1206-1671`) :
   - cycle de vie session/turn (`session.started`, `turn.started`, `turn.completed`…) →
     commande `thread.session.set` (`ProviderRuntimeIngestion.ts:1276-1358`), le statut
     étant mappé par `orchestrationSessionStatusFromRuntimeState`
     (`ProviderRuntimeIngestion.ts:228-246`) ;
   - deltas de texte assistant → streaming ou bufferisation (§8) ;
   - plans proposés (`turn.proposed.delta/completed`) → `thread.proposed-plan.upsert`
     (`ProviderRuntimeIngestion.ts:1454-1540`) ;
   - tout le reste (approbations, outils, erreurs, usage de tokens…) → *activités*
     converties par `runtimeEventToActivities`
     (`ProviderRuntimeIngestion.ts:265-628`) et redispatchées en
     `thread.activity.append` (`ProviderRuntimeIngestion.ts:1657-1670`).

   Une garde de cycle de vie stricte (`STRICT_PROVIDER_LIFECYCLE_GUARD`,
   `ProviderRuntimeIngestion.ts:57` ; `shouldApplyThreadLifecycle`,
   `ProviderRuntimeIngestion.ts:1245-1270`) rejette les transitions `turn.started` /
   `turn.completed` incohérentes avec le turn actif.
8. **Boucle fermée** : ces commandes repassent par `orchestrationEngine.dispatch` — il
   n'existe **aucune écriture directe** dans l'event store hors de l'Engine. Les
   `commandId` des réacteurs sont déterministes (préfixes `provider:…` / `server:…`,
   `ProviderRuntimeIngestion.ts:637-640`, `ProviderCommandReactor.ts:199-200`,
   `CheckpointReactor.ts:79-80`), ce qui rend la boucle idempotente en cas de rejeu.
9. **Vers le client** : chaque événement persisté part dans les flux d'abonnement
   (`subscribeThread` / `subscribeShell`, `packages/contracts/src/orchestration.ts:25-33`)
   sous forme d'items `{kind:"snapshot"} | {kind:"event"}`
   (`OrchestrationThreadStreamItem`, `orchestration.ts:1115-1125`), que le client réduit
   (§11).

En parallèle, le **CheckpointReactor** observe le même trafic pour capturer la baseline git
au démarrage du turn et le diff à sa complétion (§9).

---

## 6. La couche provider : piloter des agents hétérogènes

### 6.1 Driver → instance → adaptateur

- **`ProviderDriver`** (`provider/ProviderDriver.ts:119-157`) : une *valeur* (pas un
  service), volontairement, pour permettre plusieurs instances du même driver
  (`ProviderDriver.ts:1-21`). Il expose `configSchema`, `defaultConfig` et surtout
  `create` (`ProviderDriver.ts:154-156`) qui matérialise une **instance** dans un scope ;
  fermer le scope libère processus, fibres et fichiers.
- **`ProviderInstance`** (`ProviderDriver.ts:64-74`) : trois façades — `snapshot`
  (disponibilité/version), **`adapter`** (le runtime agentique) et `textGeneration`
  (titres, messages de commit) — plus une identité de continuité
  (`ProviderContinuationIdentity`, `ProviderDriver.ts:76-89`).
- **`ProviderAdapterShape`** (`provider/Services/ProviderAdapter.ts:45-126`) : l'interface
  unique des opérations agentiques :
  `startSession` (:55), `sendTurn` (:62), `interruptTurn` (:69), `respondToRequest` (:74),
  `respondToUserInput` (:83), `stopSession` (:92), `listSessions`/`readThread`/
  `rollbackThread`/`stopAll` (:97-120) et le flux `streamEvents` (:125).
- Le **hot-reload** est géré par `ProviderInstanceRegistry`
  (`provider/Services/ProviderInstanceRegistry.ts:1-88`) : quand la config d'une instance
  change, son scope est détruit puis recréé ; `ProviderService` se réabonne aux flux
  (`reconcileInstanceSubscriptions`, `ProviderService.ts:322-353`).

### 6.2 Les cinq drivers intégrés

Enregistrés dans `provider/builtInDrivers.ts:47-53` :

| Driver | Fichier | Protocole | Particularités |
|---|---|---|---|
| Codex | `Drivers/CodexDriver.ts:62,108` | JSON-RPC ndjson sur stdio (`codex app-server`, package `packages/effect-codex-app-server`) | homes isolés (`CODEX_HOME` + shadow home) pour multi-comptes (`CodexDriver.ts:123-146`) |
| Claude | `Drivers/ClaudeDriver.ts:59,110` | **Claude Agent SDK** (pas ACP) | sonde de capacités par instance avec cache 5 min (`ClaudeDriver.ts:153-161`) ; adaptateur `Layers/ClaudeAdapter.ts` |
| Cursor | `Drivers/CursorDriver.ts:55,93` | **ACP** (`packages/effect-acp`) + extensions Cursor | catalogue de modèles via extension (`CursorDriver.ts:149-151`) |
| Grok | `Drivers/GrokDriver.ts:42,77` | **ACP** + extension xAI (`acp/XAiAcpExtension.ts`) | mise à jour manuelle seulement (`GrokDriver.ts:44-49`) |
| OpenCode | `Drivers/OpenCodeDriver.ts:57,107` | SDK/HTTP OpenCode (`opencodeRuntime.ts`) | serveur local géré ou distant via `serverUrl` (`OpenCodeDriver.ts:8-12`) |

### 6.3 Le modèle d'événements canonique

Tous les adaptateurs convergent vers **`ProviderRuntimeEvent`**
(`packages/contracts/src/providerRuntime.ts:967-1020`) : une union discriminée d'environ
50 variantes (`ProviderRuntimeEventType`, `providerRuntime.ts:148-197`) partageant une base
commune (`providerRuntime.ts:248-262` : `eventId`, `provider`, `threadId`, `turnId?`,
`itemId?`, `requestId?`, `raw?`…). Types clés : `session.*`, `turn.started/completed`,
`item.started/updated/completed` (types d'items canoniques : `command_execution`,
`file_change`, `mcp_tool_call`, `web_search`…), `content.delta` (flux
`assistant_text`/`reasoning_text`), `request.opened/resolved` (approbations),
`user-input.requested/resolved`, `thread.token-usage.updated`. Le champ `raw.source`
conserve la provenance native (`providerRuntime.ts:21-31`) : `codex.app-server.notification`,
`claude.sdk.message`, `acp.jsonrpc`, etc.

Deux exemples de normalisation :

- **Chemin ACP (Cursor/Grok)** : le runtime `acp/AcpSessionRuntime.ts` spawne le processus
  (`AcpSessionRuntime.ts:321-343`), monte le client `effect-acp`
  (`AcpSessionRuntime.ts:345-357`), fait `initialize → authenticate → session/new` ou
  `session/load` avec attente d'idle de rejeu (`AcpSessionRuntime.ts:519-677`), puis
  sérialise les prompts par sémaphore (`AcpSessionRuntime.ts:707-748`). Les notifications
  `session/update` sont parsées par `parseSessionUpdateEvent`
  (`acp/AcpRuntimeModel.ts:508-582`) — `agent_message_chunk` → delta de texte,
  `tool_call`/`tool_call_update` → état d'outil fusionné, `plan` → mise à jour de plan —
  puis converties en événements canoniques par les fabriques de
  `acp/AcpCoreRuntimeEvents.ts` (mapping des kinds ACP vers les types canoniques,
  `AcpCoreRuntimeEvents.ts:32-61`). L'adaptateur Cursor publie le tout sur un PubSub
  (`Layers/CursorAdapter.ts:784-871`) exposé par `streamEvents` (`CursorAdapter.ts:1162`).
- **Chemin Codex** : `Layers/CodexSessionRuntime.ts` reçoit les notifications JSON-RPC de
  l'app-server et les ré-émet en événements internes (`CodexSessionRuntime.ts:827-885`) ;
  `Layers/CodexAdapter.ts` les normalise (`item/agentMessage/delta` → `content.delta`,
  `CodexAdapter.ts:894-903` ; `item/completed` → `item.completed`,
  `CodexAdapter.ts:834-856`) vers la file exposée par `streamEvents`
  (`CodexAdapter.ts:1366, 1709`).

### 6.4 Processus et transport

- **Spawn** : via `ChildProcessSpawner` d'Effect (déclaré dans l'environnement des drivers,
  `builtInDrivers.ts:35-40`). Codex : `codex app-server` avec `CODEX_HOME` injecté et
  `forceKillAfter: "2 seconds"` (`CodexSessionRuntime.ts:713-746`). ACP : résolution de la
  commande shell/PATH puis spawn scopé (`AcpSessionRuntime.ts:321-343`).
- **Transport** : les deux familles parlent du JSON délimité par lignes sur stdio. Le pont
  ACP est `makeAcpPatchedProtocol` (`packages/effect-acp/src/protocol.ts:80`) — parsing
  ndjson-rpc, routage requêtes/notifications/réponses (`protocol.ts:407-455`), méthodes
  d'extension (`protocol.ts:246-260`). L'équivalent Codex est
  `makeCodexAppServerPatchedProtocol` (`packages/effect-codex-app-server/src/protocol.ts:151`).
- **Terminaison** : la mort du processus fait échouer toutes les requêtes en attente
  (`protocol.ts:199-219, 457-472` ; `makeTerminationError`,
  `packages/effect-acp/src/_internal/stdio.ts:52-63`). Codex : l'`exitCode` observé passe
  la session en `closed` ou `error` (`CodexSessionRuntime.ts:1173-1190`). Il n'y a pas de
  redémarrage in-process : le « redémarrage » est la recréation du scope d'instance (§6.1).

---

## 7. Approbations d'outils et modes runtime (human-in-the-loop)

Le circuit d'une approbation traverse toute la boucle :

1. **Demande du provider** — Codex envoie des *requêtes serveur* JSON-RPC
   (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
   `item/tool/requestUserInput`, traitées à `CodexSessionRuntime.ts:952, 1008, 1066`) qui
   suspendent sur une `Deferred` ; en ACP, l'agent appelle `session/request_permission`
   (handler `handleRequestPermission`, `Layers/CursorAdapter.ts:665-735`). Dans les deux
   cas, l'adaptateur émet un événement canonique `request.opened`.
2. **Ingestion → activité** — `runtimeEventToActivities` produit une activité
   `tone: "approval"`, `kind: "approval.requested"` avec `{requestId, requestKind, detail}`
   (`ProviderRuntimeIngestion.ts:275-304`) ; les types canoniques de requête sont mappés
   par `requestKindFromCanonicalRequestType` (`ProviderRuntimeIngestion.ts:248-263`).
3. **Projection** — `applyPendingApprovalsProjection` crée une ligne `pending`
   (`ProjectionPipeline.ts:1338-1435`) ; le compteur `pendingApprovalCount` du thread est
   recalculé (`ProjectionPipeline.ts:574-576`).
4. **Réponse utilisateur** — l'interface dérive les approbations ouvertes en rejouant les
   activités (`derivePendingApprovals`, `apps/web/src/components/session-logic.ts:355-409`)
   et les présente dans le composer (`chat/ComposerPendingApprovalPanel.tsx`). Le handler
   `onRespondToApproval` (`ChatView.tsx:4257-4283`) envoie la commande
   `thread.approval.respond` `{requestId, decision}`
   (contrat `orchestration.ts:627-634` ; client `commands.ts:213-222`).
5. **Retour vers l'agent** — `processApprovalResponseRequested`
   (`ProviderCommandReactor.ts:886-927`) appelle
   `providerService.respondToRequest({threadId, requestId, decision})`
   (`ProviderCommandReactor.ts:906-911`). Une approbation périmée (état perdu après
   redémarrage) devient une activité d'échec « Stale pending approval »
   (`ProviderCommandReactor.ts:913-925`). Côté ACP, la décision résout la `Deferred` et se
   traduit en `optionId` ACP (`accept→allow-once`, `acceptForSession→allow-always`,
   `decline→reject-once` — `acp/AcpAdapterSupport.ts:46-56`) ; l'adaptateur émet alors
   `request.resolved`, qui referme la ligne pending
   (`ProjectionPipeline.ts:1353-1382, 1437-1454`).

Les décisions possibles : `accept | acceptForSession | decline | cancel`
(`ProviderApprovalDecision`, `packages/contracts/src/orchestration.ts:131-137`). Les
**questions structurées** (user input) suivent un chemin parallèle :
`thread.user-input.respond` → `processUserInputResponseRequested`
(`ProviderCommandReactor.ts:929-972`) → `providerService.respondToUserInput`.

**Modes runtime** : `RuntimeMode` = `approval-required | auto-accept-edits | full-access`
(défaut `full-access`) — `packages/contracts/src/orchestration.ts:117-123`. En
`full-access`, les demandes de permission ACP sont auto-approuvées côté serveur
(`selectAutoApprovedPermissionOption`, `CursorAdapter.ts:297-311`). Le mode d'interaction
(`default | plan`) et le mode de livraison du texte (`buffered | streaming`,
`orchestration.ts:129-130`) complètent la politique. (Note : la page
`docs/architecture/runtime-modes.md` ne décrit que deux modes et est en retard sur le
contrat.)

---

## 8. Streaming du texte assistant

Les deltas `content.delta` (`streamKind: assistant_text`) arrivant du provider suivent deux
régimes selon `enableAssistantStreaming` (`ProviderRuntimeIngestion.ts:1361-1407`) :

- **streaming** : chaque delta devient une commande interne
  `thread.message.assistant.delta`, dont l'événement `thread.message-sent` porte
  `streaming: true` (`decider.ts:603-628`) ; le client **concatène** les fragments au
  message assistant courant (`threadReducer.ts:194-214`) ;
- **bufferisé** : les fragments sont accumulés côté serveur (machinerie de segments
  `AssistantSegmentState`, caches `ProviderRuntimeIngestion.ts:642-667`, plafond mémoire
  `MAX_BUFFERED_ASSISTANT_CHARS`, `ProviderRuntimeIngestion.ts:56`) et livrés d'un bloc à
  la complétion de l'item ou du turn (`ProviderRuntimeIngestion.ts:1459-1576`).

Côté ACP, le texte est en outre segmenté en « items » assistants : le runtime ouvre et
ferme des segments autour des deltas (`ensureActiveAssistantSegment` /
`closeActiveAssistantSegment`, `AcpSessionRuntime.ts:832-988`), un provider pouvant émettre
plusieurs messages assistant par turn.

---

## 9. Checkpoints et diffs de turn

Le `CheckpointReactor` (`Layers/CheckpointReactor.ts:75-866`) donne à chaque turn un
« avant/après » git. Il souscrit à **deux** flux (`CheckpointReactor.ts:835-858`) : les
événements de domaine (`thread.turn-start-requested`, `thread.message-sent`,
`thread.checkpoint-revert-requested`, `thread.turn-diff-completed`) et les événements
runtime (`turn.started`/`turn.completed`).

- **Baseline pré-turn** : au démarrage du turn, capture d'un ref git caché si absent
  (`ensurePreTurnBaselineFromTurnStart`, `CheckpointReactor.ts:479-527` ;
  variante domaine `CheckpointReactor.ts:549-608`). Un checkpoint est « a hidden Git ref »
  (`docs/reference/encyclopedia.md:124` ; stockage `checkpointing/CheckpointStore.ts`).
- **Capture à la complétion** : sur `turn.completed`,
  `captureCheckpointFromTurnCompletion` (`CheckpointReactor.ts:352-415`) capture le ref
  final, calcule le diff contre la baseline (`checkpointing/CheckpointDiffQuery.ts`) et
  dispatch `thread.turn.diff.complete` (`captureAndDispatchCheckpoint`,
  `CheckpointReactor.ts:218-349`).
- **Placeholder fiable** : si l'ingestion voit un `turn.diff.updated` sans checkpoint
  existant, elle dispatch un diff `status: "missing"`
  (`ProviderRuntimeIngestion.ts:1620-1655`) que le réacteur remplace ensuite par une vraie
  capture (`captureCheckpointFromPlaceholder`, `CheckpointReactor.ts:425-477`) — voie de
  secours car le PubSub partagé ne garantit pas la livraison de `turn.completed` à ce
  réacteur (commentaire `CheckpointReactor.ts:762-766`).
- **Revert** : `thread.checkpoint.revert` → `handleRevertRequested`
  (`CheckpointReactor.ts:610-738`) restaure l'arbre de travail, **rollback la conversation
  provider** (`CheckpointReactor.ts:698-703`, via `rollbackThread` de l'adaptateur), purge
  les refs obsolètes et dispatch `thread.revert.complete`.

---

## 10. Fin de turn : complétion, interruption, quiescence

### Complétion

Le signal d'autorité est la **sortie du statut de session `running`** :
`turn.completed` est mappé en `thread.session.set` (statut `ready`, ou `error` si échec ;
`activeTurnId: null`) par l'ingestion (`ProviderRuntimeIngestion.ts:1284-1358`). Les deux
projections règlent alors le dernier turn encore `running` en
`completed`/`interrupted`/`error` via le même helper `settledTurnStateForSessionStatus`
(mémoire : `projector.ts:46-62, 490-501` ; SQL : `ProjectionPipeline.ts:78-94, 1025-1054`).
Deux subtilités :

- `thread.turn-diff-completed` ne règle jamais un turn dont la session tourne encore
  (`turnStillRunning`, `projector.ts:586-587`, `ProjectionPipeline.ts:1255-1258`) — les
  diffs de mi-parcours ne clôturent pas le turn ;
- un message assistant complet ne règle le turn que si la session n'est plus `running`
  (`settlesTurn`, `ProjectionPipeline.ts:1162-1169`) — un provider peut émettre plusieurs
  messages par turn.

### Interruption

`thread.turn.interrupt` (contrat `orchestration.ts:619-625`) → événement
`thread.turn-interrupt-requested` (`decider.ts:464-484`) → deux effets :
`processTurnInterruptRequested` appelle `providerService.interruptTurn` par session
(`ProviderCommandReactor.ts:863-884` — par session, car les identifiants de turn
d'orchestration ne sont pas ceux du provider, commentaire `ProviderCommandReactor.ts:882`),
et la projection force l'état `interrupted` (`ProjectionPipeline.ts:1212-1247`). En ACP,
l'interruption interrompt la fibre du prompt actif puis envoie `session/cancel` ; le
résultat devient `{stopReason: "cancelled"}` (`AcpSessionRuntime.ts:719-761`). Côté
interface, pendant qu'un turn tourne, le bouton d'envoi devient un bouton stop câblé sur
`onInterrupt` (`chat/ComposerPrimaryActions.tsx:126-138` ; `ChatView.tsx:4242-4255`).

### Erreurs et arrêt

Un `runtime.error` provider produit `thread.session.set` statut `error`
(`ProviderRuntimeIngestion.ts:1582-1609`). `thread.session.stop` arrête la session provider
et projette `stopped` (`processSessionStopRequested`, `ProviderCommandReactor.ts:974-1003`),
ce qui règle les turns `running` en `interrupted`. Sur `session.exited`, l'ingestion purge
tout l'état de turn en cache (`clearTurnStateForSession`,
`ProviderRuntimeIngestion.ts:1578-1580`).

### Quiescence

À la toute fin du post-traitement (diff dispatché, activité de checkpoint émise), le
CheckpointReactor publie `checkpoint.diff.finalized` puis `turn.processing.quiesced` sur le
`RuntimeReceiptBus` (`CheckpointReactor.ts:314-329` ; schémas des trois reçus
`Services/RuntimeReceiptBus.ts:23-57`). Point notable : l'implémentation de production est
un **no-op** (`publish: () => Effect.void`, `Layers/RuntimeReceiptBus.ts:22-25, 38`) ; seule
la variante de test (PubSub en mémoire, `Layers/RuntimeReceiptBus.ts:27-36, 39`) permet aux
tests d'intégration d'attendre déterministiquement la quiescence au lieu de sonder l'état —
conformément au principe « tests and orchestration code wait on these signals instead of
polling internal state » (`docs/architecture/overview.md:38`).

---

## 11. Côté client : transport, réduction d'état, interface

### Transport et abonnements (`packages/client-runtime`)

Le client n'a pas de transport maison : c'est le `RpcClient` d'Effect sur WebSocket
(`makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup)`,
`packages/client-runtime/src/rpc/protocol.ts:5` ; groupe RPC assemblé dans
`packages/contracts/src/rpc.ts`). `RpcSessionFactory.connect`
(`rpc/session.ts:70-139`) monte `Socket.layerWebSocket` (`session.ts:94`) ; l'environnement
est « connecté » quand le socket est ouvert **et** que le premier RPC de config réussit
(`session.ts:116-121`, cf. `docs/architecture/connection-runtime.md:49-56`). Les
abonnements durables (`subscribe`, `rpc/client.ts:150-237`) suivent la session courante et
**rebasculent automatiquement** sur la session de remplacement après reconnexion
(`Stream.switchMap`, `client.ts:167-168`) — le retry appartient exclusivement au
superviseur d'environnement (backoff exponentiel plafonné,
`connection-runtime.md:31-47, 118-121`).

### Réduction d'état

`makeEnvironmentThreadState` (`state/threads.ts:51-220`) : charge d'abord un cache disque
(`threads.ts:57-68`), s'abonne à `subscribeThread` (`threads.ts:199-206`), puis applique
chaque item : un `snapshot` **remplace** tout l'état et fixe `lastSequence`
(`threads.ts:157-160`) ; un `event` est **ignoré si `sequence <= lastSequence`**
(`threads.ts:163-167`), sinon réduit par la fonction pure `applyThreadDetailEvent`
(`state/threadReducer.ts:47-482`) : concaténation du texte streamé
(`threadReducer.ts:194-214`), transitions du `latestTurn`
(`threadReducer.ts:220-253, 278-323`), activités dédupliquées et triées par séquence
(`threadReducer.ts:459-471`), revert (`threadReducer.ts:409-456`). La méthode
`replayEvents` (`orchestration.ts:1213-1219`) permet de combler un trou de séquence après
coupure (récupération orchestrée par `apps/web/src/orchestrationRecovery.ts`).

Les commandes sortantes d'un même thread sont **sérialisées par un scheduler**
(environmentId, threadId) (`state/threadCommands.ts:55-59`) : il n'y a pas de file de
messages — pendant un turn, l'interface propose l'interruption, la réponse aux
approbations/questions, et le suivi de plan (« Peaufiner / Implémenter »,
`ComposerPrimaryActions.tsx:142-193`), pas l'envoi d'un second message.

### Rendu

`session-logic.ts` dérive l'affichage des données brutes : entrées de journal d'outils
(`deriveWorkLogEntries`, `session-logic.ts:627-644`), timeline fusionnée
messages + plans + travail (`deriveTimelineEntries`, `session-logic.ts:1340-1366`), phase
de session (`derivePhase`, `session-logic.ts:1381-1393`), approbations ouvertes
(`derivePendingApprovals`, `session-logic.ts:355-409`). `chat/MessagesTimeline.tsx` rend
chaque ligne : groupes d'outils (`WorkGroupSection`, `MessagesTimeline.tsx:815`), messages
assistant en Markdown avec indicateur de streaming (`MessagesTimeline.tsx:984-988`), plans
proposés (`MessagesTimeline.tsx:822`).

---

## 12. Garanties de robustesse

Conformément aux priorités du projet (« Keep behavior predictable under load and during
failures », `AGENTS.md:19`), la boucle empile plusieurs mécanismes :

| Garantie | Mécanisme | Réf. |
|---|---|---|
| Sérialisation des écritures | file de commandes unique drainée par un seul worker | `OrchestrationEngine.ts:90, 303-304` |
| Idempotence | déduplication par `commandId` (reçus accepted/rejected) ; `commandId` déterministes dans les réacteurs | `OrchestrationEngine.ts:138-151` ; `ProviderRuntimeIngestion.ts:637-640` |
| Atomicité | événements + projections + reçus dans une transaction SQL | `OrchestrationEngine.ts:169-213` |
| Ordre côté client | `sequence` monotone, dédup `lastSequence`, `replayEvents` | `orchestration.ts:989-999` ; `threads.ts:163-167` ; `orchestration.ts:1213-1219` |
| Travail asynchrone ordonné et testable | workers drainables partagés par les trois réacteurs | `ProviderRuntimeIngestion.ts:1693` ; `ProviderCommandReactor.ts:1061` ; `CheckpointReactor.ts:833` (via `packages/shared/src/DrainableWorker.ts`) |
| Synchronisation de test sans polling | reçus runtime (`turn.processing.quiesced`) | `Services/RuntimeReceiptBus.ts:23-57` |
| Échecs provider non fatals | conversion en activités d'erreur plutôt qu'arrêt de boucle | `ProviderCommandReactor.ts:217-255` |
| États de turn incohérents | garde stricte de cycle de vie | `ProviderRuntimeIngestion.ts:57, 1245-1270` |
| Crash de processus agent | erreur de terminaison propagée, session `closed`/`error`, reprise par `resumeCursor` | `effect-acp/src/protocol.ts:199-219` ; `CodexSessionRuntime.ts:1173-1190` ; `ProviderService.ts:355-438` |
| Changement de config à chaud | destruction/recréation du scope d'instance | `ProviderInstanceRegistry.ts:1-88` |
| Reconnexion client | superviseur unique du retry, abonnements qui rebasculent, snapshots en cache disque | `connection-runtime.md:31-56` ; `rpc/client.ts:150-237` ; `threads.ts:57-68` |

---

## 13. Index des fichiers de référence

### Documentation
- `docs/architecture/overview.md` — vue d'ensemble et cycles de vie (diagrammes)
- `docs/reference/encyclopedia.md` — glossaire (thread, turn, reactor, receipt, quiesced…)
- `docs/architecture/connection-runtime.md` — runtime de connexion client (fidèle au code)
- `docs/architecture/runtime-modes.md`, `docs/architecture/providers.md` — ⚠️ partiellement
  périmées par rapport aux contrats actuels

### Contrats (`packages/contracts/src`)
- `orchestration.ts` — commandes, événements, threads, activités, approbations, RPC
- `providerRuntime.ts` — modèle canonique `ProviderRuntimeEvent`
- `rpc.ts` — groupe RPC WebSocket

### Orchestration (`apps/server/src/orchestration`)
- `decider.ts`, `commandInvariants.ts`, `projector.ts`, `Normalizer.ts`, `http.ts`
- `Layers/OrchestrationEngine.ts`, `Layers/ProjectionPipeline.ts`
- `Layers/ProviderCommandReactor.ts`, `Layers/ProviderRuntimeIngestion.ts`
- `Layers/CheckpointReactor.ts`, `Layers/RuntimeReceiptBus.ts`, `Layers/OrchestrationReactor.ts`

### Providers (`apps/server/src/provider`)
- `ProviderDriver.ts`, `Services/ProviderAdapter.ts`, `Services/ProviderInstanceRegistry.ts`
- `builtInDrivers.ts`, `Drivers/{Codex,Claude,Cursor,Grok,OpenCode}Driver.ts`
- `Layers/ProviderService.ts`, `Layers/{Codex,Claude,Cursor}Adapter.ts`,
  `Layers/CodexSessionRuntime.ts`
- `acp/AcpSessionRuntime.ts`, `acp/AcpRuntimeModel.ts`, `acp/AcpCoreRuntimeEvents.ts`,
  `acp/AcpAdapterSupport.ts`

### Protocoles (`packages/`)
- `effect-acp/src/{client,protocol}.ts`, `effect-acp/src/_internal/stdio.ts`
- `effect-codex-app-server/src/{client,protocol}.ts`

### Checkpointing (`apps/server/src/checkpointing`)
- `CheckpointStore.ts`, `CheckpointDiffQuery.ts`, `Diffs.ts`, `Utils.ts`

### Client (`packages/client-runtime/src`, `apps/web/src`)
- `rpc/{protocol,session,client}.ts`, `operations/commands.ts`
- `state/{threads,threadReducer,threadCommands,threadDetail}.ts`
- `components/ChatView.tsx`, `components/session-logic.ts`,
  `components/chat/{MessagesTimeline,ComposerPrimaryActions,ComposerPendingApprovalPanel}.tsx`
