# Sommaire de traitement par tour pour le fournisseur Clawcal

## Contexte et objectif

Pendant les tests locaux avec Clawcal (Ollama + GPU local) comme fournisseur ACP dans T3 Code, le seul retour visible sur un tour est le label existant `"A travaillé pendant Xs"` (`MessagesTimeline.logic.ts`, fonction `deriveTurnFolds`). Ce label ne dit rien sur ce qui s'est passé pendant ce temps : combien d'appels d'outils, combien de tokens envoyés/reçus, combien d'itérations de la boucle agent, si le modèle a produit du raisonnement (`thinking`).

Objectif : enrichir ce label, uniquement pour les tours servis par Clawcal, avec un sommaire compact de ces informations — sans toucher au comportement des autres fournisseurs (Claude, Codex, Cursor, Grok, OpenCode).

## Portée

- **Fournisseur concerné** : Clawcal seulement. Les autres fournisseurs ne sont pas modifiés ; leur label reste identique.
- **Granularité** : par tour (un tour = un aller-retour message utilisateur → réponse finale de l'agent), pas cumulatif sur le fil entier. Ceci correspond exactement à la durée de vie actuelle du `MetricsCollector` dans `_run_turn`.
- **Hors scope** : exposer ce sommaire pour d'autres fournisseurs ; persister ces métriques côté serveur T3 Code (elles ne vivent que dans l'état du fil, comme le reste du timeline) ; corriger le défaut de journalisation ACP découvert pendant l'investigation (`setup_logging()` jamais appelé dans `main_acp()` — cf. note plus bas) ; corriger le bug du outil `bash` qui bloque 120s sur des commandes interactives Windows (`date`, `time`) — suivi séparément dans [clawcal#20](https://github.com/jlacerte/clawcal/issues/20), sans lien avec cette fonctionnalité.

## Constat de départ (déjà vérifié dans le code)

- `_run_turn` (`src/acp/server.py`) instancie déjà un `MetricsCollector` par tour et lui fait accumuler `LlmCallEvent`/`ToolEvent` au fil de la boucle `Agent.run_stream()`.
- En fin de tour, `collector.finalize()` produit déjà un `SessionEvent` complet (itérations, appels LLM, tokens in/out, nb d'outils, outils utilisés, durée, coût cloud estimé) — mais cet objet n'est aujourd'hui passé qu'à `log_session()`, qui ne fait rien car `setup_logging()` n'est jamais appelé dans le chemin ACP (`main_acp()`), seulement dans le chemin MCP (`src/server.py`). Le calcul existe donc déjà ; il est simplement jeté.
- `LlmResponse` (`src/llm_client.py`) porte déjà un champ `reasoning_content: str`, mais rien n'agrège aujourd'hui sa présence au niveau de la session.
- ACP expose un point d'extension officiel et documenté : `_meta: { [x: string]: unknown }`, présent sur la plupart des messages du protocole, prévu explicitement pour ce genre de métadonnées custom (voir [Extensibility](https://agentclientprotocol.com/protocol/extensibility)).

## Architecture

### Côté clawcal (Python)

1. **Nouveau champ `had_reasoning`** sur `LlmCallEvent` (`src/observability/events.py`), rempli via `bool(response.reasoning_content)` là où l'événement est construit.
2. **Nouveau champ `any_reasoning`** sur `SessionEvent`, calculé dans `MetricsCollector.finalize()` (`src/observability/collector.py`) comme `any(e.had_reasoning for e in self._llm_events)`.
3. Dans `_run_turn` (`src/acp/server.py`) : le `SessionEvent` produit par `collector.finalize()` est sérialisé dans le `_meta` de la réponse finale du tour (`{stopReason}` de `session/prompt`), sous une clé namespacée :

   ```json
   {
     "stopReason": "end_turn",
     "_meta": {
       "clawcal": {
         "totalIterations": 2,
         "totalToolCalls": 3,
         "totalPromptTokens": 1204,
         "totalCompletionTokens": 340,
         "anyReasoning": false,
         "durationMs": 27400
       }
     }
   }
   ```

   Ceci est indépendant de la correction éventuelle du défaut `setup_logging()` — les deux peuvent être traités séparément.

### Transport

Le champ `_meta.clawcal` voyage sur la réponse ACP existante (`session/prompt`), sans modification du schéma ACP partagé (`packages/effect-acp`) : `_meta` est déjà typé `{ [x: string]: unknown } | null` partout où il apparaît.

### Côté T3 Code (TypeScript)

1. `ClawcalAcpSupport.ts` / `AcpSessionRuntime.ts` (`apps/server/src/provider/acp/`) : lire `_meta.clawcal` sur la réponse de fin de tour et le transmettre, associé au `turnId` courant, jusqu'à l'état de session exposé au client (même mécanisme que le reste des données de tour — `OrchestrationLatestTurn`).
2. `MessagesTimeline.logic.ts`, fonction `deriveTurnFolds` : quand des stats Clawcal sont disponibles pour le `turnId` du fold, les ajouter au `label` après la durée :

   `"A travaillé pendant 27s · 3 outils · 1.2k/340 tok · 2 itérations"` (+ un petit indicateur visuel si `anyReasoning`).

   Format des tokens : `Xk` au-delà de 1000, entier en dessous (ex: `340`, pas `0.3k`).

## Gestion d'erreurs et dégradation gracieuse

- **`_meta.clawcal` absent** (fournisseur autre que Clawcal, ou ancienne version de clawcal sans ce champ) : le label reste strictement `"A travaillé pendant Xs"`, inchangé par rapport à aujourd'hui.
- **Champs partiels** (ex: version de clawcal antérieure à l'ajout de `anyReasoning`) : chaque segment du label s'affiche indépendamment ; un champ manquant est omis plutôt que d'afficher une valeur vide ou de faire échouer le rendu.
- **Tour annulé/interrompu** (`session/cancel`) : le `SessionEvent` partiel déjà accumulé au moment de l'annulation est tout de même attaché en `_meta` ; le label utilise déjà `"Tu as arrêté après Xs"` dans ce cas — les mêmes stats partielles s'y ajoutent selon le même format.

## Tests

- **Clawcal (Python)** : test unitaire sur `MetricsCollector.finalize()` vérifiant `any_reasoning=True` dès qu'au moins un `LlmCallEvent` a `had_reasoning=True`, et `False` sinon — suit le pattern des tests existants de `collector.py`.
- **T3 Code (TypeScript)** : cas ajoutés à `MessagesTimeline.logic.test.ts` pour `deriveTurnFolds` — un cas avec stats Clawcal présentes (label enrichi) et un cas sans (label inchangé, comportement actuel préservé).
- **Vérification manuelle** : relancer une conversation réelle via Clawcal dans le stack de dev T3 Code et confirmer visuellement le nouveau label sur un tour avec au moins un appel d'outil.

## Notes annexes découvertes pendant l'investigation

- Le défaut `setup_logging()` jamais appelé en mode ACP (donc `~/.clawcal/logs/clawcal.jsonl` et `metrics.db` ne reçoivent rien pour les sessions pilotées par T3 Code) reste un gain possible indépendant de cette fonctionnalité — le sommaire de tour proposé ici ne dépend pas de sa correction.
- Le bug du outil `bash` qui bloque 120s sur des commandes interactives Windows (`date`, `time`) est suivi séparément dans [clawcal#20](https://github.com/jlacerte/clawcal/issues/20).
