# Personnalités multiples pour Clawcal (ex: spécialiste soumissions)

## Contexte et objectif

Idée de départ : réutiliser T3 Code + un agent local (Clawcal/Ollama) pour un usage non-codant — gérer des soumissions (devis) comme fichiers texte suivis en Git, en profitant du même filet checkpoint/diff/revert déjà validé pour le code (voir `2026-07-03-clawcal-acp-turn-summary-design.md`).

Le system prompt de Clawcal ("senior software engineer... UNDERSTAND/PLAN/EDIT/VERIFY", `src/agent.py`) est taillé pour le code et a montré, lors de nos tests, une vraie sensibilité : certains modèles (Mistral) réagissent mal à ce style de prompt (décrivent un plan en texte au lieu d'appeler un outil), alors qu'un prompt plus directif corrige le problème. Un persona "soumissions" a besoin d'un ton, d'un glossaire et d'un jeu d'outils différents du persona "codage".

Objectif de cette spec : permettre à **une seule instance/installation de Clawcal** de servir plusieurs personas (system prompt + jeu d'outils différents), sélectionnables depuis T3 Code sans aucune modification de T3 Code lui-même.

## Portée

- Personas concernés en v1 : `codage` (existant, comportement inchangé par défaut) et `soumissions` (nouveau).
- Le persona `soumissions` reste en édition de texte pur (`read_file`/`write_file`/`edit_file`/`list_directory`) — pas d'appel `mcp_call` vers Zoho/ServiceNtre en v1 (décision déjà prise, cf. le brainstorm).
- Hors scope : nouvelle UI T3 Code, nouvelle instance de fournisseur, intégration Zoho/ServiceNtre, génération PDF.

## Constat de départ

- T3 Code supporte déjà des **instances multiples d'un même fournisseur** (`AddProviderInstanceDialog.tsx`) — une alternative sans code serait de dupliquer Clawcal en deux clones distincts, un par persona, chacun en instance séparée. Écartée ici au profit d'un seul clawcal à maintenir, avec un mécanisme de sélection interne.
- `session/set_model` (`src/acp/server.py`) prend aujourd'hui un `modelId` brut, le valide contre `GET /api/tags` d'Ollama, et l'assigne tel quel à la session — rien de spécifique au persona n'y transite.
- Le system prompt est un littéral unique dans `src/agent.py`, utilisé pour tous les tours, tous modèles confondus.

## Architecture

### Encodage du persona dans l'identifiant de modèle

Clawcal expose des identifiants de modèle "virtuels" combinant persona + tag Ollama réel, format `<persona>::<modèle ollama>` (ex: `soumissions::qwen3:8b`, `codage::qwen3:8b`). Absence de préfixe reconnu → persona `codage` par défaut (rétrocompatibilité totale avec les configurations existantes qui envoient juste `qwen3:8b`).

### Résolution côté serveur ACP (`src/acp/server.py`)

1. `_fetch_ollama_models` (ou son appelant dans la liste de modèles renvoyée à T3 Code) génère, pour chaque tag Ollama réel, une entrée par persona configuré (`codage::<tag>`, `soumissions::<tag>`) en plus du tag brut.
2. `_handle_set_model` : découpe `modelId` sur `::`. Si le préfixe correspond à un persona connu, résout le vrai tag Ollama pour la validation et l'appel LLM ; stocke le persona choisi sur la session (`session.profile`). Sinon, persona `codage` par défaut, `modelId` traité comme aujourd'hui.
3. `_run_turn` : construit l'`Agent` avec le system prompt et le sous-ensemble d'outils du `session.profile` courant (nouveau `PROFILES: dict[str, ProfileConfig]` dans `src/agent.py` ou un nouveau module `src/profiles.py`, avec au moins `codage` = comportement actuel et `soumissions` = nouveau prompt + outils réduits).

### Configuration du persona `soumissions`

- System prompt : ton et glossaire soumissions (statuts, devise, format de ligne), et une consigne directive anti-prose apprise de nos tests Mistral ("appelle l'outil directement, ne décris jamais un plan en texte").
- Outils : `read_file`, `write_file`, `edit_file`, `list_directory` uniquement (retire `bash`, `glob_tool`, `grep_tool`, `mcp_call`, `analyze_image` de la liste exposée au LLM pour ce persona).

## Gestion d'erreurs et dégradation gracieuse

- `modelId` sans préfixe reconnu, ou préfixe inconnu : traité comme `codage` (comportement actuel) — aucune régression pour les configurations existantes.
- Persona demandé mais tag Ollama réel absent (modèle non installé) : même message d'erreur qu'aujourd'hui pour un modèle inconnu, juste avec l'identifiant complet (`soumissions::modele-manquant`) dans le message.

## Tests

- Clawcal (Python) : tests unitaires sur le découpage persona/modèle dans `_handle_set_model` (préfixe connu, préfixe inconnu, absence de préfixe) et sur la sélection du bon system prompt/jeu d'outils par `_run_turn` selon `session.profile`.
- Vérification manuelle : dans T3 Code, confirmer que `codage::qwen3:8b` et `soumissions::qwen3:8b` apparaissent comme choix distincts dans le sélecteur de modèle, et qu'un tour avec chacun utilise le bon system prompt (observable via `~/.clawcal/traces/traces.jsonl`, message `system`).

## Hors scope / pistes futures

- Intégration Zoho/ServiceNtre pour le persona soumissions (via `mcp_call`, déjà démontré techniquement possible).
- Vrais commits Git (pas seulement les checkpoints T3 Code) pour un historique d'audit permanent par soumission — décision déjà prise de ne pas le faire en v1.
- Un 3e persona ou plus, une fois le mécanisme validé avec deux.
