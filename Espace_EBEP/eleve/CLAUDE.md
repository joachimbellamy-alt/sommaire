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

---

## Améliorations supplémentaires à implémenter

### Import multiple
8. **Sélection de plusieurs JSON simultanément** — ajouter `multiple` sur tous les `<input type="file" accept=".json">`. Adapter le handler pour itérer sur `e.target.files` (boucle sur tous les fichiers). Toast final : "✅ X paquets importés — Y fiches ajoutées". Dédupliquer par ID pour éviter les doublons.

### Export par matière
9. **Exporter une matière entière** — dans la future vue tuiles matières (amélioration n°5-7), ajouter un bouton ⋯ sur chaque tuile matière qui ouvre un petit menu :
   - "📤 Exporter toutes les fiches de [Matière]"
   - "🧠 Réviser toutes les fiches dues de [Matière]"
   
   La fonction d'export filtre `supports.filter(s => s.matiere === matiere)` et génère un fichier `export-[matiere]-[date].json`.

### Cartes ratées représentées dans la session (optionnel)
10. **Option dans les Réglages** — "Représenter les cartes ratées dans la même session" (oui/non, désactivé par défaut). Si activé : quand `evaluerFlash('insuffisant')` est appelé, la carte est réinjectée à la fin de `flashSession` plutôt que de simplement recevoir un intervalle de 1 jour.

---

## Contexte des 3 dernières décisions (résumé pour Claude Code)

### Couleurs des zones masquées — clarification
Les zones masquées ont deux systèmes de couleurs qui coexistent :
1. **Couleur d'identification** (par défaut) : chaque zone a sa couleur fixe par index (`COULEURS_ZONES[i % 8]`) — bleue, verte, orange, violette… Sert d'ancre mémorielle spatiale.
2. **Couleur d'évaluation** (après révélation) : vert si ✓, orange si 〜, rouge si ✗. Remplace visuellement la couleur d'identification après le tap.

→ Ce comportement est intentionnel et correct. Le micro-onboarding (amélioration n°3) devrait l'expliquer brièvement à la première utilisation.

### Cartes ratées — comportement actuel
Une carte évaluée "Aucune idée" reçoit un intervalle de 1 jour et n'est PAS réinjectée dans la session en cours. Elle revient le lendemain. C'est un choix délibéré pour éviter la frustration des collégiens. L'amélioration n°10 propose d'en faire une option dans les Réglages.

### Import multi-fichiers et export par matière
- **Import multiple** (amélioration n°8) : sélectionner plusieurs JSON d'un coup, itérer sur `e.target.files`, toast de confirmation "X paquets importés — Y fiches ajoutées", dédupliquer par ID.
- **Export par matière** (amélioration n°9) : bouton ⋯ sur chaque tuile matière → "Exporter toutes les fiches de [Matière]" → `supports.filter(s => s.matiere === matiere)` → fichier `export-[matiere]-[date].json`.

---

## Mise à jour v90 — août 2026

### Feuille d'indice refaite (v90)
La bulle flottante `.bulle-indice-edition` a été remplacée par une feuille fixe en bas d'écran (pattern iOS sheet). Elle remonte au-dessus du clavier automatiquement grâce à `position:fixed;bottom:0`. Un fond `.bulle-indice-fond` semi-transparent permet de fermer en tapant à l'extérieur. Deux boutons pleine largeur : 🗑 Effacer (rouge) et ✓ Enregistrer (bleu). Plus aucun calcul de position `visualViewport`.

### Version actuelle : v90
Les 10 améliorations du backlog (ergonomie 1-4, bibliothèque 5-7, import/export 8-9, cartes ratées 10) restent à implémenter.

---

## Améliorations pédagogiques prioritaires (points 1, 2, 4)

### Point 1 — Plan de révision ancré dans l'évaluation

Quand une fiche a une date d'évaluation dans l'agenda, l'accueil affiche un plan automatique.

**Logique :**
- Récupérer les fiches liées à une évaluation dans les 7 prochains jours
- Calculer combien de zones/cartes restent fragiles ou non maîtrisées
- Afficher sous le bloc "Aujourd'hui" une bannière contextuelle : "📅 Contrôle de SVT dans 3 jours — 8 zones à consolider" + bouton "Réviser maintenant" qui lance directement ces fiches
- Si plusieurs évaluations proches, prioriser par date croissante

**Ce qui existe déjà :** l'alerte contrôle dans `afficherTableauBord`. La rendre actionnable avec un bouton qui filtre la session sur les fiches liées à cette évaluation (via `objectif.supportId` ou correspondance par matière/nom).

---

### Point 2 — Feedback de fin de session contextualisé

Ajouter un message intelligent entre "Session terminée !" et les compteurs, basé sur le taux de maîtrise global des fiches liées au prochain contrôle.

**4 cas à gérer :**

| Situation | Message |
|---|---|
| Contrôle dans ≤ 2 jours, maîtrise < 70% | ⚠️ "Ton contrôle est demain — reviens ce soir pour consolider les zones fragiles" |
| Contrôle dans ≤ 2 jours, maîtrise ≥ 70% | ✅ "Bien préparé — une dernière révision demain matin suffira" |
| Contrôle dans 3-7 jours, maîtrise < 50% | 💪 "Continue — reviens demain, tu as encore le temps de bien préparer ce contrôle" |
| Contrôle dans 3-7 jours, maîtrise ≥ 50% | 🎯 "Bonne progression — maintiens le rythme jusqu'au contrôle" |
| Aucun contrôle proche | Message actuel inchangé |

**Calcul du taux de maîtrise global :** pour toutes les fiches liées à l'évaluation proche, calculer `maitrisees / total` via `calculerProgression(s)`. Boîtes 4-5 = maîtrisé.

---

### Point 4 — Délai de réflexion avant révélation (Option A)

Le bouton "Voir la réponse" est **grisé et inactif pendant 2 secondes** après l'affichage de la question.

**Implémentation :**
- À l'affichage de chaque carte (`afficherCarteFlash`), désactiver le bouton `.btn-voir-reponse` avec `disabled` + opacité réduite
- Afficher un texte discret sous la question : *"Essaie de te souvenir…"* (petite taille, couleur grisée)
- Après 2000ms : activer le bouton, faire disparaître le texte (transition douce)
- Ne pas bloquer si l'élève revient sur une carte déjà vue dans la session (`flashRevele` déjà true)

---

### Instruction pour Claude Code

Implémente ces 3 améliorations une par une avec validation entre chaque. Commence par le point 4 (le plus simple), puis le point 2, puis le point 1. Bumpe le service worker à chaque étape.

---

## QR Code de partage par fiche

### Objectif
Permettre à un élève de partager une fiche avec un camarade en lui faisant scanner un QR code — sans mail, sans fichier, sans infrastructure serveur.

### Comment ça fonctionne
1. L'élève ouvre le menu ⋯ d'une fiche dans "Mes fiches"
2. Il tape "Partager via QR code"
3. Un QR code s'affiche en plein écran
4. Le camarade scanne avec son iPad → l'app s'ouvre directement avec la fiche prête à importer

### Implémentation technique

**Bibliothèque QR :** utiliser `qrcode.js` depuis cdnjs (chargé à la demande, comme PDF.js) :
```
https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js
```

**Contenu du QR code :** une data URL encodée en base64 contenant le JSON de la fiche.
```javascript
const paquet = {
    type: 'sauvegarde-memo-revisions',
    version: 1,
    exporteLe: new Date().toISOString(),
    supports: [supportCible]
};
const json = JSON.stringify(paquet);
const base64 = btoa(unescape(encodeURIComponent(json)));
const urlQR = window.location.origin + window.location.pathname + '?import=' + base64;
```

**Limitation :** les fiches avec images (cours masqué) peuvent produire un QR code trop dense si l'image est volumineuse. Dans ce cas, proposer l'export JSON classique à la place et afficher un message explicatif. Vérifier la taille : si `json.length > 2000` caractères, basculer automatiquement sur l'export fichier.

**Réception :** au chargement de l'app, vérifier si l'URL contient `?import=`. Si oui, décoder le base64, parser le JSON, et déclencher l'import automatiquement avec une confirmation ("Tu vas importer la fiche X de ton camarade — OK ?").

**UI :**
- Ajouter "🔗 Partager via QR code" dans le menu ⋯ de chaque fiche (dans `actionFiche`)
- Modale plein écran avec le QR code centré, titre "Fais scanner ce code à ton camarade", bouton "Fermer"
- Le QR code doit être grand (minimum 256×256px) pour être facilement scannable

### Ordre d'implémentation
1. Ajouter la détection `?import=` au démarrage de l'app
2. Ajouter l'action "Partager via QR code" dans le menu ⋯
3. Générer et afficher le QR code dans une modale
4. Tester avec une fiche flashcard légère d'abord, puis vérifier le cas des fiches image

---

## Partage AirDrop pour les fiches avec images (cours masqués)

### Contexte
Le QR code ne peut pas encoder les fiches avec images (trop volumineuses). AirDrop est la solution naturelle sur iPad pour partager des fichiers entre appareils proches — même réseau wifi ou Bluetooth.

### Comment ça fonctionne
Techniquement, AirDrop est déclenché par le même `navigator.share({ files: [fichier] })` que l'export normal. Sur iOS, quand deux iPads sont proches et qu'AirDrop est activé, l'option AirDrop apparaît automatiquement dans la feuille de partage native.

Il n'y a donc **rien de spécial à coder** — c'est le même bouton d'export, mais l'UX doit être clarifiée pour que l'élève comprenne qu'il peut choisir AirDrop dans la feuille qui s'ouvre.

### Ce qu'il faut changer

Dans le menu ⋯ d'une fiche image (type === 'image'), remplacer le libellé :
- Avant : "📤 Exporter cette fiche"  
- Après : "📤 Partager (AirDrop, mail…)"

Et ajouter une ligne explicative sous le bouton :
> "Sur iPad : choisis AirDrop pour partager instantanément avec un camarade proche."

### Logique de décision selon le type de fiche

```javascript
// Dans actionFiche('exporter') :
if (s.type === 'texte') {
    // Proposer QR code en premier + export en second
    ouvrirSheetPartageFlashcard(s);
} else {
    // Fiche image → partage natif iOS directement (AirDrop dans la feuille)
    exporterSupportId(s.id);
    // + message toast : "Choisis AirDrop dans la feuille pour partager avec un camarade"
}
```

### Sheet de partage pour les flashcards

Quand l'élève tape "Partager" sur une fiche flashcard, afficher une petite sheet avec deux options :
- **🔗 QR Code** — "Fais scanner à ton camarade" (rapide, sans contact)
- **📤 Fichier** — "Par mail, AirDrop ou EcoleDirecte" (pour les paquets plus grands)

### Résumé du flux complet

| Type de fiche | Action | Méthode |
|---|---|---|
| Flashcards légères (< 2000 car.) | Partager | QR Code |
| Flashcards lourdes (> 2000 car.) | Partager | Fichier JSON (mail/AirDrop) |
| Cours masqué (image) | Partager | AirDrop via feuille iOS native |
| Prof → élèves | Distribuer | Fichier JSON via EcoleDirecte/mail |

---

## Clarification — Exporter vs Partager (pas de doublon)

### Décision
Supprimer le doublon "Exporter" / "Partager" dans le menu ⋯. Un seul bouton : **"📤 Partager / Exporter"**.

Ce bouton ouvre une sheet contextuelle selon le type de fiche :

**Fiche flashcard :**
- 🔗 QR Code — "Partage instantané avec un camarade"
- 📨 Fichier — "Par mail, AirDrop ou EcoleDirecte"

**Cours masqué (image) :**
- 📨 Fichier — "Par AirDrop, mail ou EcoleDirecte" (QR code impossible, image trop lourde)

### Sauvegarde complète — pas concernée
Le bouton "💾 Sauvegarder tout" dans Mes fiches et Réglages reste intact — c'est une action différente (sauvegarde de toutes les fiches, pas d'une seule). Pas de doublon ici.

### Ce qu'il faut modifier dans le code
- Dans `actionFiche` : remplacer l'action `'exporter'` par une sheet intermédiaire selon `s.type`
- Supprimer le bouton "Exporter" seul s'il existe ailleurs dans l'interface
- Le libellé dans le menu ⋯ devient "📤 Partager / Exporter"
