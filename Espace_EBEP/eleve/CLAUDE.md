# Mémo Révisions Élève — Contexte projet pour Claude Code

## Identité du projet

PWA pédagogique pour collégiens (6e/5e), développée par Josh Bellamy, professeur de français et latin.  
Déployée sur GitHub Pages : `https://joachimbellamy-alt.github.io/sommaire/Espace_EBEP/eleve/`  
Compte GitHub : `joachimbellamy-alt`  
Utilisée en classe dans le cadre d'un dispositif EBEP (Élèves à Besoins Éducatifs Particuliers).

---

## Stack technique

- **Vanilla JS** — aucun framework, aucune dépendance externe
- **PWA** — service worker avec cache-first, installable sur iPad/Mac
- **Stockage** — IndexedDB (principal) + localStorage (fallback)
- **Déploiement** — GitHub Pages (3 fichiers : `index.html`, `app.js`, `service-worker.js`)
- **PDF.js** — chargé à la demande depuis cdnjs pour l'import PDF

Chaque déploiement nécessite de bumper `CACHE_NAME` dans `service-worker.js` (ex: `memo-eleve-v88`).

---

## Architecture de l'app

### Navigation
Barre d'onglets fixe en bas (4 onglets) :
- 🏠 **Réviser** — accueil quotidien filtré (seulement les fiches avec révisions dues)
- 📚 **Mes fiches** — bibliothèque complète Matière → Chapitre → Fiches
- 📅 **Agenda** — planning de révision lié aux dates d'évaluation
- Aa **Réglages** — accessibilité + sauvegarde/restauration

### Deux types de fiches
1. **Flashcards** (`type: 'texte'`) — question/réponse, évaluation à 4 niveaux post-révélation
2. **Support de cours masqué** (`type: 'image'`) — image (photo/PDF) avec zones colorées à mémoriser

### Structure des données (IndexedDB)
```javascript
support = {
  id: String,           // identifiant unique
  nom: String,
  matiere: String,      // 'Français', 'Maths', 'Histoire-Géo-EMC', etc.
  chapitre: String,     // facultatif
  type: 'texte'|'image',
  etat: {},             // SM-2 par carte/zone (clé = index ou 'page_zone')
  creeLe: timestamp,
  // Si type === 'texte' :
  cartes: [{ question, reponse }],
  // Si type === 'image' :
  pages: [{ image: dataUrl, zones: [{ xPct, yPct, wPct, hPct, indice }] }]
}
```

---

## Algorithme de mémorisation — SM-2 à deux phases

**Fonction centrale : `appliquerSM2(etat, qualite)`**

### Phase 1 — Apprentissage (nouvelle information)
La carte reste en Phase 1 tant qu'elle n'a pas été réussie sur **au moins 2 jours calendaires distincts**.  
Intervalles bridés : Insuffisant/Fragile → 1 jour, Satisfaisant → 2 jours, Très bonne maîtrise → 3 jours max.  
Tracking via `etat.joursReussis` (tableau de dates ISO).

### Phase 2 — SM-2 complet
Dès que `joursReussis.length >= 2`, l'algorithme SM-2 espace normalement.  
Une mauvaise réponse remet `joursReussis = []` → retour en Phase 1.

### Qualités SM-2 par niveau
| Bouton | Code | Qualité SM-2 |
|--------|------|-------------|
| Réponse immédiate | `'maitrise'` | 5 |
| Réponse correcte après réflexion | `'satisfaisant'` | 4 |
| Réponse incomplète ou inexacte | `'fragile'` | 2 |
| Aucune idée | `'insuffisant'` | 0 |

---

## Flux de révision flashcard

1. Question affichée + bouton audio
2. Bouton bleu **"Voir la réponse"** → `voirReponseFlash()`
3. Réponse révélée + "Tu savais ?"
4. Grille 2×2 des 4 boutons colorés → `evaluerFlash(resultat)`
5. Bandeau de feedback + passage à la carte suivante

### Compteurs de session
```javascript
flashResultats = { maitrise: 0, satisfaisant: 0, fragile: 0, insuffisant: 0 }
```

---

## Flux de révision zones masquées

- Toutes les zones toujours opaques (fond blanc #fff, bordure colorée)
- Couleurs distinctives par zone : `COULEURS_ZONES` (palette de 8 couleurs iOS, appliquée par `index % 8`)
- 3 boutons : ✓ (qualité 5) / 〜 (qualité 2) / ✗ (qualité 0)
- 💡✓ sur le bouton indice des zones maîtrisées (boîte ≥ 4)
- "🔄 Recommencer" : remet les zones en état masqué sans toucher SM-2

---

## Fonctions clés JS

```
afficherAccueil()          → liste fiches avec révisions dues uniquement
afficherBibliotheque()     → bibliothèque Matière→Chapitre→Fiche avec search
ouvrirSheetAjouter()       → sheet iOS 4 tuiles pour créer/importer
ouvrirSheetActions(id,nom) → sheet 5 actions sur une fiche (depuis bibliothèque)
actionFiche(action)        → exécute l'action après capture id
voirReponseFlash()         → révèle la réponse
evaluerFlash(resultat)     → SM-2, compteurs, bandeau, carte suivante
afficherFinSessionFlash()  → écran fin avec 4 colonnes de stats
chargerPageRevision()      → zones colorées, try/catch silencieux
declarer(masque, resultat) → évaluation zone (oui/moyen/non)
appliquerSM2(etat, qual)   → algorithme complet avec phases apprentissage
afficherTableauBord()      → bloc Aujourd'hui, streak, alerte contrôle
afficherBibliotheque()     → bibliothèque avec search et délégation événements
ajouterPageDepuisImage()   → ajoute page sans rafraîchir le canvas à chaque fois
partagerSupport()          → export iOS-compatible (Web Share API + fallback)
appliquerPreferencesDys()  → police (Système/Arial/OpenDyslexic) sur body entier
```

---

## Décisions d'architecture importantes

- **SM-2 toujours actif** — plus de toggle Mode Pro/Simple
- **Agenda toujours visible** — onglet permanent, plus de toggle
- **"Support de cours masqué"** — terminologie officielle (pas "schéma")
- **"Fiche"** — terme utilisé partout (pas "support")
- **Délégation d'événements** avec `data-fiche-id` (compatibilité Safari)
- **Boutons Safari** — utiliser `<button type="button">` + `-webkit-appearance:none` + styles inline pour garantir les couleurs sur iOS
- **Import PDF** — toutes les pages ajoutées en mémoire en boucle, puis UN seul `chargerCanvasEdition()` à la fin
- **Pas de `{ once: true }`** sur les écouteurs de la bibliothèque — remplacé par `dataset.listenerInit`

---

## Bugs connus / Points de vigilance

### Safari iOS spécifique
- Les `<div>` sans `onclick=""` ou `cursor:pointer` ne reçoivent pas les événements click
- Les couleurs CSS sur `<button>` sont écrasées par le style natif → utiliser styles **inline** + `-webkit-appearance:none`
- `a.download` ne déclenche pas de téléchargement → utiliser Web Share API + fallback alert

### Service worker
- Toujours bumper `CACHE_NAME` à chaque déploiement
- Sur Mac : `Cmd+Shift+R` pour rechargement forcé
- Sur iPad Safari : Réglages → Safari → Avancé → Données de sites → supprimer

### Imports
- `inputImport`, `inputImportFlash`, `inputImportTotal` partagent le même handler
- Format JSON attendu : `{ type: "sauvegarde-memo-revisions", version: 1, supports: [...] }`

---

## CSS — variables principales

```css
--bleu: #007AFF
--vert: #34C759
--rouge: #FF3B30
--orange: #FF9500
--surface: #ffffff
--gris-fond: #F2F2F7
--texte: #1C1C1E
--gris-texte: #8E8E93
--bord: rgba(0,0,0,0.1)
--ombre: 0 1px 3px rgba(0,0,0,0.08)
```

---

## Format JSON pour import de flashcards (générable par IA)

```json
{
  "type": "sauvegarde-memo-revisions",
  "version": 1,
  "exporteLe": "2026-01-01T00:00:00.000Z",
  "supports": [{
    "id": "identifiant-unique",
    "nom": "Titre de la fiche",
    "matiere": "Maths",
    "chapitre": "Ch. 1 — Nom du chapitre",
    "type": "texte",
    "etat": {},
    "mode": "simple",
    "creeLe": 1700000000000,
    "cartes": [
      { "question": "...", "reponse": "..." }
    ]
  }]
}
```

Matières valides : `Français`, `Maths`, `Histoire-Géo-EMC`, `Anglais`, `Espagnol`, `EMI`, `Sciences`, `SVT`, `Sciences physiques`, `Latin`, `Éducation musicale`, `Arts plastiques`, `Autre`

---

## Version actuelle

**v88** — août 2026

---

## Améliorations ergonomiques à implémenter (prochaine session)

### Flashcards
1. **Tap sur la carte = révéler** — en plus du bouton "Voir la réponse", un tap n'importe où sur le bloc question/réponse doit révéler la réponse (comme Anki). Le bouton reste pour ceux qui le cherchent.
2. **Libellés des 4 boutons à raccourcir** — les libellés longs ("Réponse correcte après réflexion") sont compressés sur petit écran. Proposer une version courte sur une ligne + sous-titre grisé :
   - "Aucune idée" → titre + rien (déjà court)
   - "〜 Réponse incomplète" + sous-titre grisé "ou inexacte"
   - "● Correcte après réflexion" (raccourci)
   - "✓ Réponse immédiate" → déjà court

### Zones masquées
3. **Micro-onboarding création de zone** — à la première ouverture d'un support image vide (0 zones), afficher une animation ou tooltip discret : "👆 Appuie et glisse pour créer une zone à mémoriser". Disparaît après la première zone tracée. Stocker en localStorage qu'il a été vu.
4. **Écran de fin de page zones** — quand toutes les zones d'une page ont été évaluées (✓/〜/✗), afficher un message discret en bas : "✅ Toutes les zones évaluées — " + boutons "🔄 Recommencer" et "→ Page suivante" si multi-pages.

### Tuiles par matière dans "Mes fiches" (refonte bibliothèque)
5. **Vue 1 : grille de tuiles colorées** — une tuile par matière, grille 2×2, avec icône + nom + "X fiches · Y dues" + barre de progression blanche. Couleurs par matière (voir COULEURS_MATIERES ci-dessous).
6. **Vue 2 : détail d'une matière** — tap sur une tuile → en-tête coloré + liste des chapitres en accordéon (repliés par défaut) + badge rouge/orange/vert selon les révisions dues. Fiches visibles seulement dans le chapitre déplié. Bouton ⋯ sur chaque fiche.
7. **Bouton retour** "‹ Toutes les matières" pour revenir à la grille.

```javascript
const COULEURS_MATIERES_TUILES = {
    'Français':          'linear-gradient(140deg,#007AFF,#0040CC)',
    'Maths':             'linear-gradient(140deg,#FF9500,#CC6600)',
    'Histoire-Géo-EMC':  'linear-gradient(140deg,#34C759,#1A7A35)',
    'Anglais':           'linear-gradient(140deg,#FF3B30,#AA0000)',
    'Espagnol':          'linear-gradient(140deg,#FF6B35,#CC4400)',
    'Latin':             'linear-gradient(140deg,#AF52DE,#6A1A9A)',
    'SVT':               'linear-gradient(140deg,#5AC8FA,#0077AA)',
    'Sciences physiques':'linear-gradient(140deg,#5856D6,#2A28A0)',
    'EMI':               'linear-gradient(140deg,#FF2D55,#AA0033)',
    'Éducation musicale':'linear-gradient(140deg,#FF9500,#6B4200)',
    'Arts plastiques':   'linear-gradient(140deg,#FF6CAE,#CC0066)',
    'Autre':             'linear-gradient(140deg,#8E8E93,#48484A)',
};
```

### Autres
- Mise à jour automatique du service worker (afficher une bannière quand une nouvelle version est disponible, bouton "Mettre à jour")
- Reconnaissance vocale sur les champs de saisie des flashcards et des indices de zones

---

## Version actuelle : v89 (août 2026)
