# barre-usage

Mod pour Claude Code : une ligne compacte au-dessus de la zone de saisie (application de bureau et terminal), dans toutes les sessions.

`S [133k/200k] $4.88    5h ▬▬── 42% +18% 2h00    Sem. ▬▬▬─ 61% -11% 3j    ⚙`

- **S** : la pastille montre le contexte utilisé sur la taille de la fenêtre (bleue, orange au-delà de 80 %, rouge au-delà de 90 %), suivie du coût de la session en dollars (équivalent API, le chiffre de `/cost`).
- **5h** et **Sem.** : consommation des limites de l'abonnement, puis l'écart au rythme régulier (vert `+` : de la marge ; rouge `-` : plus vite que le rythme, la fenêtre se remplira avant le reset si ça continue), puis le temps avant le reset.
- **⚙** ouvre une ligne de détail, qui reste ouverte d'une session à l'autre : total du jour toutes sessions confondues, coût moyen par heure, heure des resets et projection au reset (ou heure où le plafond serait atteint), âge du relevé quand il vient d'une autre session, modèle, durée et nombre de messages.

L'écart `+18%` se lit en points dans la fenêtre en cours : 3 h écoulées sur 5 h, le rythme régulier serait à 60 % ; à 42 % consommés, il reste 18 points d'avance. Ce n'est pas une comparaison avec la session ou la semaine précédente.

Les libellés sont en français. Le fuseau horaire est celui de la machine (Europe/Paris quand il est introuvable).

## Installation

À l'invite d'une session Claude Code dans un terminal :

```
/plugin install barre-usage --marketplace pr0d-CadenzIA/claude-code-mods-status-line
```

Répondre `y` pour ajouter le marketplace, puis choisir la portée utilisateur (Entrée) : la barre est active tout de suite, et dans chaque nouvelle session.

Depuis un shell :

```bash
claude plugin install barre-usage --marketplace pr0d-CadenzIA/claude-code-mods-status-line
```

Dans l'application de bureau, où `/plugin` ne fonctionne pas : cliquer sur + à côté de la zone de saisie, puis Plugins, Add marketplace avec `pr0d-CadenzIA/claude-code-mods-status-line`, puis Add plugin. Un mod installé depuis un terminal en portée utilisateur s'affiche aussi dans l'application de bureau.

## Où sont les données

| Quoi | Où |
|---|---|
| Relevés partagés entre sessions | `~/.claude/barre-usage/limits.json` (dernières fenêtres 5 h et semaine) et `~/.claude/barre-usage/sessions/<id>.json` (coût de chaque session, pour le total du jour) |
| Ligne de détail ouverte ou fermée | stockage du mod dans Claude Code |

Avec `CLAUDE_CONFIG_DIR`, le dossier `barre-usage/` est créé sous ce répertoire. Ces fichiers ne contiennent que des chiffres (pourcentages, dates de reset, montants) : ni prompt ni contenu de conversation. Rien ne sort de la machine.

## Limites connues

- Les fenêtres 5 h et semaine n'existent qu'avec un abonnement, et ne sont connues qu'après une première réponse du modèle. Une nouvelle session affiche le dernier relevé d'une autre session, avec son âge.
- Le total du jour compte une session déjà ouverte avant l'installation de la barre seulement à partir du moment où la barre l'a vue.
- Le coût en dollars est l'équivalent au tarif API, pas ce qui est facturé sur un abonnement.

## Désactiver, désinstaller

```bash
claude plugin disable barre-usage@claude-code-mods-status-line
```

```bash
claude plugin uninstall barre-usage@claude-code-mods-status-line
```

## Développement

Depuis un clone du dépôt, après une modification : `/reload-plugins` dans une session lancée avec `claude --plugin-dir <clone>`.

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
