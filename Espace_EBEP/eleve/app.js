/* ============================================================
   Application élève — création et révision fusionnées
   Stockage : localStorage, clé "memo_supports_v2"
   ============================================================ */

let supports = [];
let supportActif = null;
let vueActuelle = 'accueil';

let zoomLevel = 1, imgNaturalW = 0, imgNaturalH = 0;
let startX, startY, currentRect, drawing = false;
let etatRevision = null;
let toastTimer = null;

const CLICK_THRESHOLD = 6;
const INTERVALLES = [0, 1, 3, 7, 16]; // jours avant prochaine révision (Mode simple, Leitner), indexé sur (boîte - 1)

// Palette iOS pour les zones image — 8 couleurs distinctes et accessibles
const COULEURS_ZONES = [
    { bord: '#007AFF', fond: 'rgba(0,122,255,0.06)' },   // Bleu
    { bord: '#34C759', fond: 'rgba(52,199,89,0.06)' },    // Vert
    { bord: '#FF9500', fond: 'rgba(255,149,0,0.06)' },    // Orange
    { bord: '#AF52DE', fond: 'rgba(175,82,222,0.06)' },   // Violet
    { bord: '#FF2D55', fond: 'rgba(255,45,85,0.06)' },    // Rose
    { bord: '#5AC8FA', fond: 'rgba(90,200,250,0.06)' },   // Bleu ciel
    { bord: '#FF3B30', fond: 'rgba(255,59,48,0.06)' },    // Rouge
    { bord: '#5856D6', fond: 'rgba(88,86,214,0.06)' },    // Indigo
];

/* ---------------- Algorithme SM-2 (façon Anki) — utilisé en Mode complet ---------------- */

function qualiteSM2(bon, confiance) {
    if (!bon) return 0; // "Again"
    if (confiance === 'aucune') return 3; // bonne réponse mais incertaine : limite du seuil de passage
    if (confiance === 'incertain') return 4; // "Good"
    return 5; // "Easy"
}

function initialiserSM2(etat) {
    if (etat.easeFactor === undefined) etat.easeFactor = 2.5;
    if (etat.repetitions === undefined) etat.repetitions = Math.max(0, (etat.box || 1) - 1);
    if (etat.intervalle === undefined) etat.intervalle = INTERVALLES[Math.max(0, (etat.box || 1) - 1)] || 1;
}

function appliquerSM2(etat, qualite) {
    initialiserSM2(etat);
    const today = todayStr();
    const bonneReponse = qualite >= 4; // satisfaisant ou très bonne maîtrise

    // ── Phase d'apprentissage ──────────────────────────────────────────
    // La carte reste en apprentissage tant qu'elle n'a pas été correctement
    // rappelée sur au moins 2 JOURS CALENDAIRES DIFFÉRENTS.
    // Ceci garantit qu'une information a survécu au sommeil au moins une fois.
    if (!etat.joursReussis) etat.joursReussis = [];

    if (bonneReponse) {
        // Ajouter le jour courant s'il est nouveau
        if (!etat.joursReussis.includes(today)) {
            etat.joursReussis.push(today);
            // Garder seulement les 10 derniers (éviter accumulation)
            if (etat.joursReussis.length > 10) etat.joursReussis.shift();
        }
    } else {
        // Mauvaise réponse : réinitialiser le compteur de jours
        etat.joursReussis = [];
        etat.repetitions = 0;
    }

    const joursDistincts = etat.joursReussis.length;
    const diplome = joursDistincts >= 2; // a survécu au sommeil au moins une fois

    if (!diplome) {
        // ── Phase 1 : apprentissage — intervalles courts bridés ──
        if (!bonneReponse) {
            etat.intervalle = 1;          // Insuffisant/Fragile → demain
        } else if (qualite === 4) {
            etat.intervalle = 2;          // Satisfaisant → dans 2 jours
        } else {
            etat.intervalle = 3;          // Très bonne maîtrise → dans 3 jours max
        }
    } else {
        // ── Phase 2 : SM-2 normal ────────────────────────────────────
        if (qualite < 3) {
            etat.repetitions = 0;
            etat.intervalle = 1;
        } else {
            if (etat.repetitions === 0) etat.intervalle = 1;
            else if (etat.repetitions === 1) etat.intervalle = 6;
            else etat.intervalle = Math.round(etat.intervalle * etat.easeFactor);
            etat.repetitions += 1;
        }
        etat.easeFactor = etat.easeFactor + (0.1 - (5 - qualite) * (0.08 + (5 - qualite) * 0.02));
        if (etat.easeFactor < 1.3) etat.easeFactor = 1.3;
    }

    etat.nextDue = addDays(today, etat.intervalle);
    etat.box = paletVisuelDepuisIntervalle(etat.intervalle);
    etat.diplome = diplome; // utile pour l'affichage éventuel
}

function paletVisuelDepuisIntervalle(intervalle) {
    if (intervalle <= 1) return 1;
    if (intervalle <= 3) return 2;
    if (intervalle <= 7) return 3;
    if (intervalle <= 16) return 4;
    return 5;
}

function majEchecsConsecutifs(etat, bon) {
    etat.echecsConsecutifs = bon ? 0 : (etat.echecsConsecutifs || 0) + 1;
    etat.difficile = etat.echecsConsecutifs >= 3;
}
const canvasEl = document.getElementById('zoneCanvas');

/* ---------------- Stockage (IndexedDB, avec repli et migration depuis localStorage) ---------------- */

const DB_NOM = 'memo_revisions_db';
const DB_VERSION = 1;
const MAGASIN = 'donnees';
const CLE_SUPPORTS = 'supports';
const ANCIENNE_CLE_LOCALSTORAGE = 'memo_supports_v2';

function ouvrirDB() {
    return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) { reject(new Error('IndexedDB indisponible')); return; }
        const req = indexedDB.open(DB_NOM, DB_VERSION);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(MAGASIN)) {
                req.result.createObjectStore(MAGASIN);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function chargerSupports() {
    try {
        const db = await ouvrirDB();
        const donnees = await new Promise((resolve, reject) => {
            const tx = db.transaction(MAGASIN, 'readonly');
            const req = tx.objectStore(MAGASIN).get(CLE_SUPPORTS);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        if (donnees) return donnees;
        // Rien en IndexedDB : on tente une migration depuis l'ancien localStorage
        const migres = migrerDepuisLocalStorage();
        if (migres.length > 0) {
            supports = migres;
            await sauvegarderSupports();
        }
        return migres;
    } catch (e) {
        // IndexedDB indisponible sur cet appareil : repli sur localStorage (capacité réduite)
        return migrerDepuisLocalStorage();
    }
}

function migrerDepuisLocalStorage() {
    try {
        const raw = localStorage.getItem(ANCIENNE_CLE_LOCALSTORAGE);
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

async function sauvegarderSupports() {
    try {
        const db = await ouvrirDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(MAGASIN, 'readwrite');
            tx.objectStore(MAGASIN).put(supports, CLE_SUPPORTS);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        // Repli sur localStorage si IndexedDB échoue (capacité plus faible)
        try {
            localStorage.setItem(ANCIENNE_CLE_LOCALSTORAGE, JSON.stringify(supports));
        } catch (e2) {
            alert("Espace de stockage insuffisant ou indisponible sur cet appareil. Essaie de supprimer un ancien support, ou exporte tes données en sauvegarde avant qu'il ne soit trop tard.");
        }
    }
}

// Version "différée" pour les champs texte : évite d'écrire tout le tableau
// `supports` (toutes les fiches, toutes matières confondues) en base à
// chaque frappe au clavier. Avec une bibliothèque de fiches qui grossit
// (une centaine de fiches, images incluses), sauvegarder à chaque lettre
// tapée peut créer une sensation de saccade. On regroupe donc les frappes
// rapprochées et on n'écrit qu'une fois la pause dépassée.
let _timerSauvegardeDifferee = null;
function sauvegarderSupportsDifferee(delaiMs = 400) {
    clearTimeout(_timerSauvegardeDifferee);
    _timerSauvegardeDifferee = setTimeout(sauvegarderSupports, delaiMs);
}

function genererId() {
    return 'sup_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------------- Suivi de série (streak) ---------------- */

/* ---------------- Mode adapté (DYS) ---------------- */

const CLE_DYS = 'preferencesDys';
const DYS_DEFAUT = { actif: false, police: 'systeme', taille: 100, lettres: 0, lignes: 15 };
let preferencesDys = Object.assign({}, DYS_DEFAUT);

async function chargerPreferencesDys() {
    try {
        const db = await ouvrirDB();
        const donnees = await new Promise((resolve, reject) => {
            const tx = db.transaction(MAGASIN, 'readonly');
            const req = tx.objectStore(MAGASIN).get(CLE_DYS);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return donnees ? Object.assign({}, DYS_DEFAUT, donnees) : Object.assign({}, DYS_DEFAUT);
    } catch (e) {
        try {
            const raw = localStorage.getItem('memo_dys_v1');
            return raw ? Object.assign({}, DYS_DEFAUT, JSON.parse(raw)) : Object.assign({}, DYS_DEFAUT);
        } catch (e2) {
            return Object.assign({}, DYS_DEFAUT);
        }
    }
}

async function sauvegarderPreferencesDys() {
    try {
        const db = await ouvrirDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(MAGASIN, 'readwrite');
            tx.objectStore(MAGASIN).put(preferencesDys, CLE_DYS);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        try { localStorage.setItem('memo_dys_v1', JSON.stringify(preferencesDys)); } catch (e2) { /* tant pis */ }
    }
}

function appliquerPreferencesDys() {
    document.body.classList.toggle('mode-dys', !!preferencesDys.actif);
    // Police appliquée sur tout le body
    const policeMap = {
        'dyslexique': "'OpenDyslexic', sans-serif",
        'arial': "Arial, 'Helvetica Neue', sans-serif",
        'systeme': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    };
    const police = policeMap[preferencesDys.police] || policeMap['systeme'];
    document.body.style.fontFamily = police;
    document.documentElement.style.setProperty('--police-dys', police);
    document.documentElement.style.setProperty('--taille-dys', (preferencesDys.taille / 100) + 'em');
    document.documentElement.style.setProperty('--espacement-lettres-dys', (preferencesDys.lettres / 100) + 'em');
    document.documentElement.style.setProperty('--espacement-lignes-dys', (preferencesDys.lignes / 10));
}

function ouvrirModalDys() {
    document.getElementById('champDysActif').checked = !!preferencesDys.actif;
    document.getElementById('champDysPolice').value = preferencesDys.police;
    document.getElementById('champDysTaille').value = preferencesDys.taille;
    document.getElementById('champDysLettres').value = preferencesDys.lettres;
    document.getElementById('champDysLignes').value = preferencesDys.lignes;
    majAffichageReglagesDys();
    document.getElementById('modalDys').classList.add('ouverte');
}

function fermerModalDys() {
    document.getElementById('modalDys').classList.remove('ouverte');
}

function majAffichageReglagesDys() {
    document.getElementById('valeurDysTaille').textContent = preferencesDys.taille + '%';
    document.getElementById('valeurDysLettres').textContent = (preferencesDys.lettres / 100).toFixed(2) + 'em';
    document.getElementById('valeurDysLignes').textContent = (preferencesDys.lignes / 10).toFixed(1);
    const policeMap = {
        'dyslexique': "'OpenDyslexic', sans-serif",
        'arial': "Arial, 'Helvetica Neue', sans-serif",
        'systeme': "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    };
    const apercu = document.getElementById('apercuDys');
    apercu.style.fontFamily = policeMap[preferencesDys.police] || policeMap['systeme'];
    apercu.style.fontSize = (preferencesDys.taille / 100) + 'em';
    apercu.style.letterSpacing = (preferencesDys.lettres / 100) + 'em';
    apercu.style.lineHeight = (preferencesDys.lignes / 10);
}

function changerDys(champ, valeur) {
    if (champ === 'actif') preferencesDys.actif = valeur;
    else if (champ === 'police') preferencesDys.police = valeur;
    else if (champ === 'taille') preferencesDys.taille = parseInt(valeur, 10);
    else if (champ === 'lettres') preferencesDys.lettres = parseInt(valeur, 10);
    else if (champ === 'lignes') preferencesDys.lignes = parseInt(valeur, 10);
    majAffichageReglagesDys();
    appliquerPreferencesDys();
    sauvegarderPreferencesDys();
}

const CLE_STREAK = 'streak';

async function chargerStreak() {
    try {
        const db = await ouvrirDB();
        const donnees = await new Promise((resolve, reject) => {
            const tx = db.transaction(MAGASIN, 'readonly');
            const req = tx.objectStore(MAGASIN).get(CLE_STREAK);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return donnees || { jours: 0, derniereVisite: null };
    } catch (e) {
        try {
            const raw = localStorage.getItem('memo_streak_v1');
            return raw ? JSON.parse(raw) : { jours: 0, derniereVisite: null };
        } catch (e2) {
            return { jours: 0, derniereVisite: null };
        }
    }
}

async function sauvegarderStreak(streak) {
    try {
        const db = await ouvrirDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(MAGASIN, 'readwrite');
            tx.objectStore(MAGASIN).put(streak, CLE_STREAK);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        try { localStorage.setItem('memo_streak_v1', JSON.stringify(streak)); } catch (e2) { /* tant pis pour le streak */ }
    }
}

let streakActuel = { jours: 0, derniereVisite: null };

async function mettreAJourStreak() {
    streakActuel = await chargerStreak();
    const aujourdhui = todayStr();
    if (streakActuel.derniereVisite === aujourdhui) {
        // déjà compté aujourd'hui, rien à changer
    } else if (streakActuel.derniereVisite === addDays(aujourdhui, -1)) {
        streakActuel.jours += 1;
        streakActuel.derniereVisite = aujourdhui;
        await sauvegarderStreak(streakActuel);
    } else {
        streakActuel.jours = 1;
        streakActuel.derniereVisite = aujourdhui;
        await sauvegarderStreak(streakActuel);
    }
}

/* ---------------- Rappel calendrier (.ics) — plusieurs rappels possibles ---------------- */

let rappelsEnAttente = [];
const NOMS_JOURS = { MO: 'Lun', TU: 'Mar', WE: 'Mer', TH: 'Jeu', FR: 'Ven', SA: 'Sam', SU: 'Dim' };

function ouvrirMenuContextuel() { document.getElementById('modalContextuel').classList.add('ouverte'); }
function fermerMenuContextuel() { document.getElementById('modalContextuel').classList.remove('ouverte'); }
// Aliases pour compatibilité
function ouvrirMenuPlus() { ouvrirMenuContextuel(); }
function fermerMenuPlus() { fermerMenuContextuel(); }
function ouvrirMenuExercices() { ouvrirMenuContextuel(); }
function fermerMenuExercices() { fermerMenuContextuel(); }

function ouvrirModalRappel() {
    if (!supportActif) return;
    rappelsEnAttente = [];
    afficherListeRappelsEnAttente();
    document.getElementById('titreModalRappel').textContent = '📅 Rappels — ' + supportActif.nom;
    document.getElementById('champFrequenceRappel').value = 'jour';
    majAffichageChampsRappel();
    document.getElementById('modalRappel').classList.add('ouverte');
}

function fermerModalRappel() {
    document.getElementById('modalRappel').classList.remove('ouverte');
}

function majAffichageChampsRappel() {
    const f = document.getElementById('champFrequenceRappel').value;
    document.getElementById('joursSemaineRappel').style.display = f === 'semaine' ? '' : 'none';
    document.getElementById('dateUniqueRappelWrap').style.display = f === 'unique' ? '' : 'none';
}

function formaterDateICS(d) {
    return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function ajouterRappelListe() {
    const heureVal = document.getElementById('champHeureRappel').value || '18:00';
    const frequence = document.getElementById('champFrequenceRappel').value;
    const entree = { heure: heureVal, frequence: frequence };

    if (frequence === 'semaine') {
        const jours = Array.from(document.querySelectorAll('#joursSemaineRappel input:checked')).map(c => c.value);
        if (jours.length === 0) { alert('Coche au moins un jour de la semaine.'); return; }
        entree.jours = jours;
    } else if (frequence === 'unique') {
        const date = document.getElementById('champDateRappel').value;
        if (!date) { alert('Choisis une date.'); return; }
        entree.date = date;
    }

    rappelsEnAttente.push(entree);
    afficherListeRappelsEnAttente();
}

function supprimerRappelListe(i) {
    rappelsEnAttente.splice(i, 1);
    afficherListeRappelsEnAttente();
}

function resumeRappel(entree) {
    if (entree.frequence === 'jour') return 'Tous les jours à ' + entree.heure;
    if (entree.frequence === 'semaine') return entree.jours.map(j => NOMS_JOURS[j]).join(', ') + ' à ' + entree.heure;
    return 'Le ' + entree.date.split('-').reverse().join('/') + ' à ' + entree.heure;
}

function afficherListeRappelsEnAttente() {
    const conteneur = document.getElementById('listeRappelsEnAttente');
    if (rappelsEnAttente.length === 0) { conteneur.innerHTML = ''; return; }
    conteneur.innerHTML = rappelsEnAttente.map((r, i) => `
        <div class="ligne-rappel-attente">
            <span>⏰ ${resumeRappel(r)}</span>
            <button onclick="supprimerRappelListe(${i})">✕</button>
        </div>
    `).join('');
}

function prochaineOccurrenceJour(heure, minute, joursCodes) {
    const codesParJourSemaine = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const maintenant = new Date();
    for (let i = 0; i < 8; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        d.setHours(heure, minute, 0, 0);
        if (joursCodes.includes(codesParJourSemaine[d.getDay()]) && d > maintenant) return d;
    }
    const repli = new Date();
    repli.setDate(repli.getDate() + 7);
    repli.setHours(heure, minute, 0, 0);
    return repli;
}

function construireVEVENT(entree, nomSupport, supportId, index) {
    const [heure, minute] = entree.heure.split(':').map(Number);
    let debut, rrule = '';

    if (entree.frequence === 'jour') {
        debut = new Date();
        debut.setHours(heure, minute, 0, 0);
        if (debut < new Date()) debut.setDate(debut.getDate() + 1);
        rrule = 'RRULE:FREQ=DAILY';
    } else if (entree.frequence === 'semaine') {
        debut = prochaineOccurrenceJour(heure, minute, entree.jours);
        rrule = 'RRULE:FREQ=WEEKLY;BYDAY=' + entree.jours.join(',');
    } else {
        const [an, mois, jour] = entree.date.split('-').map(Number);
        debut = new Date(an, mois - 1, jour, heure, minute, 0, 0);
    }
    const fin = new Date(debut.getTime() + 15 * 60000);
    const uid = 'memo-revisions-' + supportId + '-' + index + '-' + Date.now() + '@joachimbellamy-alt.github.io';

    const lignes = [
        'BEGIN:VEVENT',
        'UID:' + uid,
        'DTSTAMP:' + formaterDateICS(new Date()),
        'DTSTART:' + formaterDateICS(debut),
        'DTEND:' + formaterDateICS(fin)
    ];
    if (rrule) lignes.push(rrule);
    lignes.push(
        'SUMMARY:🧠 Réviser : ' + nomSupport,
        'DESCRIPTION:Ouvre l\'app Mes révisions et reprends le support « ' + nomSupport + ' ».',
        'END:VEVENT'
    );
    return lignes;
}

function telechargerRappels() {
    if (!supportActif) return;
    if (rappelsEnAttente.length === 0) { alert("Ajoute au moins un rappel à la liste avant de télécharger."); return; }

    let lignes = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mes Revisions//FR'];
    rappelsEnAttente.forEach((entree, i) => {
        lignes = lignes.concat(construireVEVENT(entree, supportActif.nom, supportActif.id, i));
    });
    lignes.push('END:VCALENDAR');
    const ics = lignes.join('\r\n');

    const blob = new Blob([ics], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rappels-' + supportActif.nom.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '.ics';
    a.click();
    fermerModalRappel();
}

/* ---------------- Sauvegarde / restauration manuelle (fichier .json) ---------------- */

function exporterDonnees() {
    if (supports.length === 0) { alert("Tu n'as encore aucune fiche à exporter."); return; }
    const paquet = { type: 'sauvegarde-memo-revisions', version: 1, exporteLe: new Date().toISOString(), supports: supports };
    const blob = new Blob([JSON.stringify(paquet, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = 'sauvegarde-revisions-' + dateStr + '.json';
    a.click();
    // Mémoriser la date de sauvegarde
    localStorage.setItem('memo_derniere_sauvegarde', Date.now().toString());
    cacherBannieresSauvegarde();
}

function exporterSupportId(id) {
    const s = supports.find(x => x.id === id);
    if (!s) return;
    const ancienSupport = supportActif;
    supportActif = s;
    partagerSupport().then(() => { supportActif = ancienSupport; });
}

async function partagerSupport() {
    if (!supportActif) return;
    const paquet = { type: 'sauvegarde-memo-revisions', version: 1, exporteLe: new Date().toISOString(), supports: [supportActif] };
    const texte = JSON.stringify(paquet, null, 2);
    const nomFichier = 'support-' + supportActif.nom.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) + '.json';
    const blob = new Blob([texte], { type: 'application/json' });

    // On utilise partout le téléchargement natif du navigateur (<a download>).
    // C'est fiable sur Mac, Android ET iOS/iPadOS Safari (depuis iOS 13) : le
    // fichier part directement dans Fichiers > Téléchargements, sans dépendre
    // d'une feuille de partage — sur Mac, cette feuille n'a pas d'option
    // "Enregistrer", et sur iOS, elle refuse de partager certains types de
    // fichiers (dont le JSON), ce qui empêchait "Enregistrer dans Fichiers"
    // d'apparaître.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nomFichier;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    if (/iP(hone|ad|od)/.test(navigator.userAgent)) {
        setTimeout(() => {
            alert('Fichier téléchargé.\n\nTu le retrouves dans l\'app Fichiers, dossier "Téléchargements" (ou via l\'icône de téléchargement ⬇️ dans Safari).');
        }, 400);
    }
}

document.getElementById('inputImport').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
        let paquet;
        try {
            paquet = JSON.parse(ev.target.result);
        } catch (err) {
            alert('Ce fichier n\'est pas un JSON valide.\n\nVérifie qu\'il n\'y a pas d\'erreur de syntaxe.');
            return;
        }

        let importes = [];

        // Format 1 : tableau direct de supports
        if (Array.isArray(paquet)) {
            if (paquet.length > 0 && paquet[0].cartes !== undefined) {
                importes = paquet; // tableau de supports complets
            } else if (paquet.length > 0 && (paquet[0].question !== undefined || paquet[0].recto !== undefined)) {
                // Tableau de cartes brutes → un seul support
                importes = [creerSupportDepuisCartesBrutes(paquet, file.name.replace('.json',''))];
            }
        }
        // Format 2 : objet avec clé "supports"
        else if (paquet.supports && Array.isArray(paquet.supports)) {
            importes = paquet.supports;
        }
        // Format 3 : objet avec clé "cartes" (format IA courant)
        else if (paquet.cartes && Array.isArray(paquet.cartes)) {
            importes = [creerSupportDepuisCartesBrutes(paquet.cartes, paquet.nom || paquet.titre || file.name.replace('.json',''))];
        }
        // Format 4 : objet avec clé "flashcards"
        else if (paquet.flashcards && Array.isArray(paquet.flashcards)) {
            importes = [creerSupportDepuisCartesBrutes(paquet.flashcards, paquet.nom || paquet.titre || file.name.replace('.json',''))];
        }
        // Format 5 : support unique (objet avec cartes)
        else if (paquet.nom && paquet.type) {
            importes = [paquet];
        }

        if (!importes.length) {
            alert('Format non reconnu.\n\nL\'app accepte ces formats :\n\n• {"supports": [{...}]}\n• {"cartes": [{"recto":"...", "verso":"..."}]}\n• [{"question":"...", "reponse":"..."}]\n\nDemande à l\'IA de générer les cartes au format :\n{"cartes": [{"recto": "Question", "verso": "Réponse"}]}');
            return;
        }

        importes.forEach((s) => {
            supports.push(Object.assign({}, s, { id: genererId() }));
        });
        migrerVersPagesEtType(supports);
        await sauvegarderSupports();
        afficherAccueil();
        alert('✅ ' + importes.length + ' fiche(s) importée(s) avec succès.');
    };
    reader.readAsText(file);
    e.target.value = '';
};

function creerSupportDepuisCartesBrutes(cartesBrutes, nom) {
    const cartes = cartesBrutes.map(c => ({
        id: genererId(),
        recto: c.recto || c.question || c.front || c.terme || c.mot || String(Object.values(c)[0] || ''),
        verso: c.verso || c.reponse || c.back || c.definition || c.traduction || String(Object.values(c)[1] || ''),
        audio: ''
    })).filter(c => c.recto && c.verso);
    return {
        id: genererId(),
        nom: nom || 'Fiche importée',
        matiere: 'Autre',
        type: 'texte',
        cartes: cartes,
        etat: {},
        creeLe: Date.now()
    };
}

/* ---------------- Bannière "Ajouter à l'écran d'accueil" ---------------- */

function estStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function afficherBanniereEcranAccueilSiBesoin() {
    if (estStandalone()) return;
    if (sessionStorage.getItem('banniere_masquee')) return;
    const banniere = document.getElementById('banniereAjoutEcran');
    if (banniere) banniere.style.display = 'flex';
}

function fermerBanniereEcranAccueil() {
    document.getElementById('banniereAjoutEcran').style.display = 'none';
    try { sessionStorage.setItem('banniere_masquee', '1'); } catch (e) { /* tant pis */ }
}

/* ---------------- Navigation entre vues ---------------- */

let ongletActif = 'reviser'; // 'reviser' | 'agenda' | 'reglages'

function goTab(tab) {
    ongletActif = tab;
    ['tabReviser','tabSupports','tabAgenda','tabReglages'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('actif');
    });
    if (tab === 'reviser') {
        document.getElementById('tabReviser').classList.add('actif');
        afficherAccueil();
    } else if (tab === 'supports') {
        document.getElementById('tabSupports').classList.add('actif');
        afficherVue('supports');
        afficherBibliotheque();
    } else if (tab === 'agenda') {
        document.getElementById('tabAgenda').classList.add('actif');
        afficherVue('agenda');
        rendreAgenda();
    } else if (tab === 'reglages') {
        document.getElementById('tabReglages').classList.add('actif');
        afficherVue('reglages');
        afficherEspaceStockage();
    }
}

function afficherVue(nom) {
    const TOUTES = ['vueAccueil','vueEdition','vueRevision','vueRecadrage','vueEditionTexte',
        'vueRevisionCarte','vueQCMTexte','vueEcrireTexte','vueAgenda','vueReglages','vueSupports'];
    TOUTES.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const cible = document.getElementById('vue' + nom.charAt(0).toUpperCase() + nom.slice(1));
    if (cible) cible.style.display = '';

    // Titre du header selon la vue
    const titres = {
        accueil: 'Mes révisions',
        supports: 'Mes fiches',
        edition: supportActif ? supportActif.nom : '',
        revision: supportActif ? supportActif.nom : '',
        recadrage: 'Recadrage',
        editionTexte: supportActif ? supportActif.nom : '',
        revisionCarte: supportActif ? supportActif.nom : '🔀 Session mélangée',
        qcmTexte: '📝 ' + (supportActif ? supportActif.nom : ''),
        ecrireTexte: '⌨️ ' + (supportActif ? supportActif.nom : ''),
        agenda: 'Mon agenda de révision',
        reglages: 'Réglages',
    };
    const titreEl = document.getElementById('titreHeader');
    if (titreEl) titreEl.textContent = titres[nom] || 'Mes révisions';
    vueActuelle = nom;

    // Le bouton flottant "+" n'a de sens que là où on gère la liste de fiches
    const fab = document.getElementById('fabAjouter');
    if (fab) fab.style.display = (nom === 'accueil' || nom === 'supports') ? 'flex' : 'none';
}

function retourAccueil() {
    sauvegarderSupports();
    supportActif = null;
    afficherAccueil();
}

const ORDRE_MATIERES = [
    'Français', 'Maths', 'Histoire-Géo-EMC', 'Anglais', 'Espagnol', 'EMI',
    'Sciences', 'SVT', 'Sciences physiques', 'Latin', 'Éducation musicale', 'Arts plastiques', 'Autre'
];
const ICONES_MATIERES = {
    'Français': '📖', 'Maths': '📐', 'Histoire-Géo-EMC': '🌍', 'Anglais': '🇬🇧', 'Espagnol': '🇪🇸',
    'EMI': '📰', 'Sciences': '🧪', 'SVT': '🔬', 'Sciences physiques': '⚛️', 'Latin': '🏛️',
    'Éducation musicale': '🎵', 'Arts plastiques': '🎨', 'Autre': '📦'
};
// Dégradé de couleur par matière — tuiles de la bibliothèque
const GRADIENTS_MATIERES = {
    'Français': ['#007AFF', '#0040CC'],
    'Maths': ['#FF9500', '#CC6600'],
    'Histoire-Géo-EMC': ['#34C759', '#1A7A35'],
    'Anglais': ['#FF3B30', '#AA0000'],
    'Espagnol': ['#FFCC00', '#B38600'],
    'EMI': ['#5856D6', '#34328C'],
    'Sciences': ['#00C7BE', '#007A73'],
    'SVT': ['#5AC8FA', '#0077AA'],
    'Sciences physiques': ['#AF52DE', '#6A1A9A'],
    'Latin': ['#A2845E', '#5C4A2E'],
    'Éducation musicale': ['#FF2D55', '#99102F'],
    'Arts plastiques': ['#DA5AA6', '#8C2E68'],
    'Autre': ['#8E8E93', '#48484A'],
};
function gradientMatiere(nom) {
    const g = GRADIENTS_MATIERES[nom] || GRADIENTS_MATIERES['Autre'];
    return `linear-gradient(140deg, ${g[0]}, ${g[1]})`;
}

function calculerProgression(s) {
    let total = 0, maitrisees = 0, difficiles = 0;
    if (s.type === 'texte') {
        total = (s.cartes || []).length;
        for (let i = 0; i < total; i++) {
            const e = s.etat && s.etat[i];
            if (e && e.box >= 4) maitrisees++;
            if (e && e.difficile) difficiles++;
        }
    } else {
        (s.pages || []).forEach((page, pi) => {
            page.zones.forEach((z, zi) => {
                total++;
                const e = s.etat && s.etat[pi + '_' + zi];
                if (e && e.box >= 4) maitrisees++;
                if (e && e.difficile) difficiles++;
            });
        });
    }
    return { maitrisees, total, difficiles };
}

function vignetteSupport(s) {
    if (s.type === 'texte') return '';
    return (s.pages && s.pages[0] && s.pages[0].image) || '';
}

const PLAFOND_PAR_JOUR = 20;

function calculerResumeAujourdhui() {
    const today = todayStr();
    let dueImage = 0, dueTexte = 0, supportsConcernes = new Set();
    supports.forEach(s => {
        if (s.type === 'texte') {
            (s.cartes || []).forEach((c, i) => {
                const e = s.etat && s.etat[i];
                if (e && e.nextDue <= today) { dueTexte++; supportsConcernes.add(s.id); }
            });
        } else {
            (s.pages || []).forEach((page, pi) => {
                page.zones.forEach((z, zi) => {
                    const e = s.etat && s.etat[pi + '_' + zi];
                    if (e && e.nextDue <= today) { dueImage++; supportsConcernes.add(s.id); }
                });
            });
        }
    });
    return { dueImage, dueTexte, total: dueImage + dueTexte, supports: supportsConcernes.size };
}

function afficherTableauBord() {
    const r = calculerResumeAujourdhui();
    const nb = Math.min(r.total, PLAFOND_PAR_JOUR);

    // Nombre
    const nombreEl = document.getElementById('ajNombre');
    if (nombreEl) nombreEl.textContent = nb;

    // Sous-titre
    const sousEl = document.getElementById('ajSous');
    if (sousEl) {
        if (r.total === 0) {
            sousEl.textContent = 'Rien à réviser aujourd\'hui, bravo ! 🎉';
        } else {
            const parties = [];
            if (r.dueTexte > 0) parties.push(r.dueTexte + ' flashcard' + (r.dueTexte > 1 ? 's' : ''));
            if (r.dueImage > 0) parties.push(r.dueImage + ' zone' + (r.dueImage > 1 ? 's' : '') + ' image');
            sousEl.textContent = parties.join(' · ');
        }
    }

    // Durée estimée (~18 secondes par élément)
    const dureeEl = document.getElementById('dureeEstimee');
    if (dureeEl && nb > 0) {
        const minutes = Math.max(1, Math.round(nb * 18 / 60));
        dureeEl.textContent = '~' + minutes + ' min';
        dureeEl.style.display = '';
    } else if (dureeEl) dureeEl.style.display = 'none';

    // Streak : compter les jours actifs cette semaine
    const streakEl = document.getElementById('streakJours');
    const swEl = document.getElementById('streakSemaine');
    const jours = streakActuel.jours;
    const joursActifsSemaine = Math.min(jours, 7);

    if (streakEl) {
        if (jours === 0) streakEl.textContent = 'Commence aujourd\'hui !';
        else if (jours === 1) streakEl.textContent = 'Révisé aujourd\'hui 👏';
        else streakEl.textContent = joursActifsSemaine + ' fois cette semaine';
    }

    // Barre des 7 jours — styles inline pour garantir le rendu
    if (swEl && jours > 0) {
        const LETTRES = ['L','M','M','J','V','S','D'];
        const today = new Date();
        const jourSemaine = today.getDay() === 0 ? 6 : today.getDay() - 1;
        swEl.style.cssText = 'display:flex;flex-direction:row;align-items:center;justify-content:space-between;background:#fff;border-radius:16px;padding:12px 16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,0.08);gap:12px;';
        swEl.innerHTML =
            '<div style="display:flex;align-items:center;gap:9px;flex-shrink:0;">'
            + '<span style="font-size:26px;line-height:1;">🔥</span>'
            + '<div><div style="font-size:20px;font-weight:800;color:#FF9500;line-height:1;">' + joursActifsSemaine + '</div>'
            + '<div style="font-size:11px;color:#8E8E93;margin-top:1px;">cette semaine</div></div>'
            + '</div>'
            + '<div style="display:flex;flex-direction:row;align-items:flex-end;gap:5px;">'
            + LETTRES.map((l, i) => {
                const actif = i <= jourSemaine && i >= jourSemaine - joursActifsSemaine + 1;
                return '<div style="display:flex;flex-direction:column;align-items:center;gap:3px;">'
                    + '<div style="width:20px;height:5px;border-radius:3px;background:' + (actif ? '#FF9500' : '#E5E5EA') + ';"></div>'
                    + '<div style="font-size:9px;font-weight:600;color:#8E8E93;">' + l + '</div>'
                    + '</div>';
            }).join('')
            + '</div>';
    } else if (swEl) swEl.style.display = 'none';

    // Alerte contrôle si agenda actif et évaluation proche (< 7 jours)
    const alerteEl = document.getElementById('alerteControle');
    if (alerteEl && objectifs.length > 0) {
        const today = new Date(); today.setHours(0,0,0,0);
        const prochaine = objectifs
            .filter(o => o.dateEval)
            .map(o => ({ ...o, date: new Date(o.dateEval + 'T00:00:00') }))
            .filter(o => o.date >= today)
            .sort((a, b) => a.date - b.date)[0];
        if (prochaine) {
            const diffJ = Math.round((prochaine.date - today) / 86400000);
            if (diffJ <= 7) {
                const msg = diffJ === 0 ? '⚠️ Contrôle aujourd\'hui : ' + prochaine.titre
                          : diffJ === 1 ? '📅 Contrôle demain : ' + prochaine.titre
                          : '📅 Contrôle dans ' + diffJ + ' jours : ' + prochaine.titre;
                alerteEl.textContent = msg;
                alerteEl.style.display = '';
            } else alerteEl.style.display = 'none';
        } else alerteEl.style.display = 'none';
    } else if (alerteEl) alerteEl.style.display = 'none';

    // Bouton Commencer (cartes du jour)
    const btnCommencer = document.getElementById('btnCommencer');
    if (btnCommencer) btnCommencer.style.display = nb > 0 ? '' : 'none';

    // Bouton Tout réviser (session mélangée, si des flashcards existent)
    const btnTout = document.getElementById('btnToutReviser');
    if (btnTout) {
        const hasFlash = supports.some(s => s.type === 'texte' && s.cartes && s.cartes.length > 0);
        btnTout.style.display = hasFlash ? '' : 'none';
    }
}

function afficherAccueil() {
    afficherVue('accueil');
    afficherTableauBord();
    verifierRappelSauvegarde();
    const liste = document.getElementById('listeSupports');
    if (supports.length === 0) {
        liste.innerHTML = '<div class="vide">Tu n\'as pas encore de support. Tape le + pour commencer !</div>';
        return;
    }

    // Séparer supports avec révisions dues vs à jour
    const aujourd = todayStr();
    const supportsDus = supports.filter(s => {
        if (s.type === 'texte') {
            return (s.cartes || []).some((c, i) => {
                const e = s.etat && s.etat[i];
                return !e || !e.nextDue || e.nextDue <= aujourd;
            });
        } else {
            return (s.pages || []).some((p, pi) =>
                (p.zones || []).some((z, zi) => {
                    const e = s.etat && s.etat[pi + '_' + zi];
                    return !e || !e.nextDue || e.nextDue <= aujourd;
                })
            );
        }
    });
    const supportsAJour = supports.filter(s => !supportsDus.includes(s));

    if (supportsDus.length === 0) {
        liste.innerHTML = `<div style="text-align:center;padding:20px;color:var(--gris-texte);font-size:13px;">
            ✅ Tous tes supports sont à jour !<br>
            <button onclick="goTab('supports')" style="margin-top:10px;background:none;border:none;color:var(--bleu);font-size:13px;cursor:pointer;">Voir tous mes supports →</button>
        </div>`;
        return;
    }

    const renderSupport = (s) => {
        const { maitrisees, total } = calculerProgression(s);
        const pct = total > 0 ? Math.round(maitrisees / total * 100) : 0;
        const r = 13, circonf = 2 * Math.PI * r;
        const dash = (pct / 100) * circonf;
        const couleur = pct >= 80 ? '#34C759' : pct >= 40 ? '#FF9500' : '#007AFF';
        const dues = s.type === 'texte'
            ? (s.cartes || []).filter((c, i) => { const e = s.etat && s.etat[i]; return !e || !e.nextDue || e.nextDue <= aujourd; }).length
            : (s.pages || []).reduce((a, p, pi) => a + (p.zones || []).filter((z, zi) => { const e = s.etat && s.etat[pi + '_' + zi]; return !e || !e.nextDue || e.nextDue <= aujourd; }).length, 0);
        const unite = s.type === 'texte' ? 'carte' : 'zone';
        return `<div class="carte-support" data-id="${s.id}" style="cursor:pointer;">
            ${vignetteSupport(s)
                ? `<img src="${vignetteSupport(s)}" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:10px;flex-shrink:0;">`
                : `<div style="width:44px;height:44px;border-radius:10px;background:#EAF3FF;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">${s.type === 'texte' ? '🗒️' : '🖼️'}</div>`
            }
            <div style="flex:1;min-width:0;">
                <div style="font-weight:600;font-size:14px;color:var(--texte);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${echapperHtml(s.nom)}</div>
                <div style="font-size:11px;color:var(--rouge);margin-top:2px;font-weight:500;">${dues} ${unite}${dues > 1 ? 's' : ''} à réviser</div>
            </div>
            <div style="position:relative;width:34px;height:34px;flex-shrink:0;">
                <svg viewBox="0 0 30 30" width="34" height="34" style="display:block;">
                    <circle cx="15" cy="15" r="${r}" fill="none" stroke="#E5E5EA" stroke-width="3"/>
                    <circle cx="15" cy="15" r="${r}" fill="none" stroke="${couleur}" stroke-width="3"
                        stroke-dasharray="${dash.toFixed(1)} ${(circonf - dash).toFixed(1)}"
                        stroke-linecap="round" transform="rotate(-90 15 15)"/>
                </svg>
                <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;color:${couleur};">${pct}%</div>
            </div>
        </div>`;
    };

    // Grouper les supports dus par matière
    const parMatiere = {};
    supportsDus.forEach(s => {
        const m = s.matiere || 'Autre';
        if (!parMatiere[m]) parMatiere[m] = [];
        parMatiere[m].push(s);
    });
    const matieresPresentes = ORDRE_MATIERES.filter(m => parMatiere[m]);
    Object.keys(parMatiere).forEach(m => { if (!matieresPresentes.includes(m)) matieresPresentes.push(m); });

    let html = matieresPresentes.map(m => `
        <div class="titre-matiere">${ICONES_MATIERES[m] || '📦'} ${m}</div>
        ${parMatiere[m].map(s => renderSupport(s)).join('')}
    `).join('');

    if (supportsAJour.length > 0) {
        html += `<button onclick="goTab('supports')" style="width:100%;text-align:center;padding:12px;background:none;border:1px dashed var(--bord-fort);border-radius:12px;color:var(--gris-texte);font-size:13px;cursor:pointer;font-family:inherit;margin-top:4px;">
            ✅ ${supportsAJour.length} support${supportsAJour.length > 1 ? 's' : ''} à jour · Voir tous mes supports →
        </button>`;
    }

    liste.innerHTML = html;

    liste.querySelectorAll('.carte-support').forEach(carte => {
        const id = carte.getAttribute('data-id');
        carte.addEventListener('click', () => ouvrirRevision(id));
    });
    afficherEspaceStockage();
}

async function afficherEspaceStockage() {
    const el = document.getElementById('espaceStockage');
    if (!el) return;
    if ('caches' in window) {
        try {
            const keys = await caches.keys();
            const versionEl = document.getElementById('versionApp');
            if (versionEl && keys.length > 0) {
                versionEl.textContent = keys[keys.length - 1].replace('memo-eleve-', '');
            }
        } catch(e) { /* tant pis */ }
    }

    // Calculer la taille réelle des données de l'app (plus fiable que l'estimate Safari)
    try {
        const json = JSON.stringify({ supports, objectifs });
        const octets = new Blob([json]).size;
        const affichage = octets < 1024 * 1024
            ? Math.round(octets / 1024) + ' Ko'
            : (octets / (1024 * 1024)).toFixed(1) + ' Mo';
        el.innerHTML = '💾 Données : <strong>' + affichage + '</strong>'
            + '<span style="color:var(--gris-texte);font-size:11px;display:block;margin-top:2px;">'
            + supports.length + ' fiche' + (supports.length > 1 ? 's' : '')
            + ' · Stockage local sur cet appareil</span>';
    } catch(e) {
        el.textContent = '';
    }
}

function definirTexte(id, texte) {
    const el = document.getElementById(id);
    if (el) el.textContent = texte;
}

let idSupportEnEdition = null;

function creerNouveauSupport(typePrefill) {
    idSupportEnEdition = null;
    definirTexte('titreModalSupport', 'Nouvelle fiche');
    definirTexte('btnValiderSupport', 'Créer');
    document.getElementById('champNomSupport').value = '';
    document.getElementById('champChapitreSupport').value = '';
    document.getElementById('champDateEval').value = '';
    document.getElementById('champMatiereSupport').value = 'Français';
    document.getElementById('champTypeSupport').value = typePrefill || 'image';
    document.getElementById('ligneTypeSupport').style.display = '';
    document.getElementById('modalNouveauSupport').classList.add('ouverte');
    setTimeout(() => document.getElementById('champNomSupport').focus(), 50);
}

function ouvrirModifierSupport(id) {
    const s = supports.find(x => x.id === id);
    if (!s) return;
    idSupportEnEdition = id;
    definirTexte('titreModalSupport', 'Modifier la fiche');
    definirTexte('btnValiderSupport', 'Enregistrer');
    document.getElementById('champNomSupport').value = s.nom;
    document.getElementById('champChapitreSupport').value = s.chapitre || '';
    document.getElementById('champMatiereSupport').value = s.matiere || 'Autre';
    document.getElementById('ligneTypeSupport').style.display = 'none';
    document.getElementById('modalNouveauSupport').classList.add('ouverte');
    setTimeout(() => document.getElementById('champNomSupport').focus(), 50);
}

function fermerModalNouveauSupport() {
    document.getElementById('modalNouveauSupport').classList.remove('ouverte');
    idSupportEnEdition = null;
}

function validerNouveauSupport() {
    const nom = document.getElementById('champNomSupport').value.trim() || 'Sans titre';
    const matiere = document.getElementById('champMatiereSupport').value;
    const chapitre = document.getElementById('champChapitreSupport').value.trim();
    const dateEval = document.getElementById('champDateEval').value;

    if (idSupportEnEdition) {
        const s = supports.find(x => x.id === idSupportEnEdition);
        if (s) {
            s.nom = nom;
            s.matiere = matiere;
            s.chapitre = chapitre;
            sauvegarderSupports();
            if (supportActif && supportActif.id === s.id) {
                document.getElementById('titreHeader').textContent = s.nom;
            }
        }
        idSupportEnEdition = null;
        fermerModalNouveauSupport();
        afficherAccueil();
        return;
    }

    const type = document.getElementById('champTypeSupport').value;
    const support = {
        id: genererId(),
        nom: nom,
        matiere: matiere,
        chapitre: chapitre,
        type: type,
        etat: {},
        mode: 'simple',
        creeLe: Date.now()
    };
    if (type === 'texte') {
        support.cartes = [];
    } else {
        support.pages = [{ image: '', zones: [] }];
    }
    supports.push(support);
    sauvegarderSupports();

    // Ajouter dans l'agenda si une date d'évaluation est renseignée
    if (dateEval) {
        const objectif = {
            id: genererId(),
            titre: nom + (matiere ? ' — ' + matiere : ''),
            dateEval: dateEval,
            joursNbr: [1, 3, 7],
            joursPlanning: calculerJoursPlanning(dateEval, [1, 3, 7]),
            faite: false,
            supportId: support.id
        };
        objectifs.push(objectif);
        sauvegarderObjectifs();
    }

    document.getElementById('champDateEval').value = '';
    fermerModalNouveauSupport();
    ouvrirEdition(support.id);
}

let pageActuelle = 0;

function ouvrirEdition(id) {
    supportActif = supports.find(s => s.id === id);
    if (!supportActif) return;
    pageActuelle = 0;
    if (supportActif.type === 'texte') {
        afficherVue('editionTexte');
        chargerEditionTexte();
        return;
    }
    afficherVue('edition');
    chargerCanvasEdition();
}

function ouvrirRevision(id) {
    supportActif = supports.find(s => s.id === id);
    if (!supportActif) return;
    pageActuelle = 0;
    if (supportActif.type === 'texte') {
        if (!supportActif.cartes || supportActif.cartes.length === 0) {
            alert("Cette fiche n'a pas encore de carte. Ajoute-en d'abord.");
            ouvrirEdition(id);
            return;
        }
        afficherVue('revisionCarte');
        construireVueRevisionCarte(supportActif.cartes.map((c, i) => ({ support: supportActif, idx: i })));
        return;
    }
    const totalZones = (supportActif.pages || []).reduce((acc, p) => acc + p.zones.length, 0);
    if (!supportActif.pages || supportActif.pages.length === 0 || totalZones === 0) {
        alert("Cette fiche n'a pas encore d'image ou de zones. Ajoute-les d'abord.");
        ouvrirEdition(id);
        return;
    }
    afficherVue('revision');
    construireVueRevision();
}

/* ---------------- Édition : pages, zoom, zones ---------------- */

function pageEnCours() {
    return supportActif.pages[pageActuelle];
}

function majNavigateurPages(prefixeId) {
    const total = supportActif.pages.length;
    const el = document.getElementById(prefixeId + 'IndicateurPage');
    if (el) {
        el.textContent = 'Page ' + (pageActuelle + 1) + '/' + total;
    }
    const btnPrec = document.getElementById(prefixeId + 'PagePrecedente');
    const btnSuiv = document.getElementById(prefixeId + 'PageSuivante');
    if (btnPrec) btnPrec.disabled = (pageActuelle === 0);
    if (btnSuiv) btnSuiv.disabled = (pageActuelle === total - 1);

    // Masquer le navigateur si une seule page, le mettre en valeur sinon
    const nav = btnPrec && btnPrec.closest('.segment-group');
    if (nav) {
        nav.style.display = total > 1 ? '' : 'none';
        if (total > 1 && prefixeId === 'revision') {
            nav.style.background = 'var(--bleu-clair)';
            nav.style.borderRadius = '12px';
            nav.style.padding = '4px 8px';
        }
    }
}

function pagePrecedenteEdition() {
    if (pageActuelle > 0) { pageActuelle--; chargerCanvasEdition(); }
}
function pageSuivanteEdition() {
    if (pageActuelle < supportActif.pages.length - 1) { pageActuelle++; chargerCanvasEdition(); }
}

function supprimerPageActuelle() {
    if (supportActif.pages.length <= 1) { alert("Impossible de supprimer la dernière page d'un support — supprime plutôt le support entier depuis l'accueil."); return; }
    if (!confirm('Supprimer cette page et ses zones ?')) return;
    supportActif.pages.splice(pageActuelle, 1);
    // Recalage des clés d'état Leitner : celles des pages après la page supprimée décalent d'un index.
    const nouvelEtat = {};
    Object.keys(supportActif.etat || {}).forEach(cle => {
        const [p, z] = cle.split('_').map(Number);
        if (p < pageActuelle) nouvelEtat[cle] = supportActif.etat[cle];
        else if (p > pageActuelle) nouvelEtat[(p - 1) + '_' + z] = supportActif.etat[cle];
        // les entrées de la page supprimée (p === pageActuelle) sont simplement abandonnées
    });
    supportActif.etat = nouvelEtat;
    if (pageActuelle >= supportActif.pages.length) pageActuelle = supportActif.pages.length - 1;
    sauvegarderSupports();
    chargerCanvasEdition();
}

function chargerCanvasEdition() {
    canvasEl.innerHTML = '';
    const page = pageEnCours();
    if (page && page.image) {
        const img = document.createElement('img');
        img.onload = () => {
            imgNaturalW = img.naturalWidth;
            imgNaturalH = img.naturalHeight;
            zoomReset();
            redessinerZonesEdition();
        };
        img.src = page.image;
        canvasEl.appendChild(img);
    }
    majCompteurZonesEdition();
    majNavigateurPages('edition');
}

function ajouterPageDepuisImage(dataUrlFinal) {
    const derniere = supportActif.pages[supportActif.pages.length - 1];
    if (supportActif.pages.length === 1 && derniere && derniere.image === '' && derniere.zones.length === 0) {
        derniere.image = dataUrlFinal;
        pageActuelle = 0;
    } else {
        supportActif.pages.push({ image: dataUrlFinal, zones: [] });
        pageActuelle = supportActif.pages.length - 1;
    }
    sauvegarderSupports();
    chargerCanvasEdition();
}

document.getElementById('inputPhotoNouvellePage').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        // Toujours ajouter une NOUVELLE page
        const lancer = (dataUrl) => {
            supportActif.pages.push({ image: dataUrl, zones: [] });
            pageActuelle = supportActif.pages.length - 1;
            sauvegarderSupports();
            chargerCanvasEdition();
            afficherToastMsg('📷 Page ' + supportActif.pages.length + ' ajoutée');
        };
        ouvrirRecadrageAvecCallback(ev.target.result, lancer);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
};

document.getElementById('inputPhoto').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        ouvrirRecadrage(ev.target.result);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
};

let pdfJsCharge = false;
function chargerPdfJs() {
    return new Promise((resolve, reject) => {
        if (window.pdfjsLib) { pdfJsCharge = true; resolve(); return; }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
        script.onload = () => {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
            pdfJsCharge = true;
            resolve();
        };
        script.onerror = () => reject(new Error('chargement impossible'));
        document.head.appendChild(script);
    });
}

function redimensionnerCanvas(source, maxW) {
    let w = source.width, h = source.height;
    if (w <= maxW) return source;
    h = Math.round(h * maxW / w); w = maxW;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(source, 0, 0, w, h);
    return c;
}

document.getElementById('inputPdf').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    if (!pdfJsCharge) {
        try { await chargerPdfJs(); }
        catch (err) {
            alert("Impossible de charger le lecteur PDF — vérifie ta connexion internet (cette fonction a besoin du réseau, contrairement au reste de l'app).");
            return;
        }
    }
    const reader = new FileReader();
    reader.onload = async (ev) => {
        try {
            const pdf = await window.pdfjsLib.getDocument({ data: ev.target.result }).promise;
            const nPages = pdf.numPages;
            for (let n = 1; n <= nPages; n++) {
                const page = await pdf.getPage(n);
                const viewport = page.getViewport({ scale: 2 });
                const canvasPage = document.createElement('canvas');
                canvasPage.width = viewport.width;
                canvasPage.height = viewport.height;
                await page.render({ canvasContext: canvasPage.getContext('2d'), viewport: viewport }).promise;
                const finalCanvas = redimensionnerCanvas(canvasPage, 1280);
                const dataUrl = finalCanvas.toDataURL('image/jpeg', 0.85);
                // Ajouter la page sans rafraîchir le canvas à chaque fois
                const derniere = supportActif.pages[supportActif.pages.length - 1];
                if (supportActif.pages.length === 1 && derniere && derniere.image === '' && derniere.zones.length === 0) {
                    derniere.image = dataUrl;
                } else {
                    supportActif.pages.push({ image: dataUrl, zones: [] });
                }
            }
            // Aller à la première page et rafraîchir une seule fois
            pageActuelle = 0;
            sauvegarderSupports();
            chargerCanvasEdition();
            afficherToastMsg('✅ ' + nPages + ' page' + (nPages > 1 ? 's' : '') + ' importée' + (nPages > 1 ? 's' : '') + ' avec succès');
        } catch (err) {
            alert('Erreur lors de la lecture du PDF : ' + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
};

document.getElementById('champReponseEcrire').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (document.getElementById('champReponseEcrire').disabled) questionSuivanteEcrire();
    else validerEcrire();
});

/* ---------------- Recadrage avant utilisation ---------------- */

let imgRecadrageNaturalW = 0, imgRecadrageNaturalH = 0;
let cropRect = null;
let startXCrop, startYCrop, currentRectCrop, drawingCrop = false;
const canvasRecadrageEl = document.getElementById('canvasRecadrage');

function ouvrirRecadrage(dataUrlOriginal) {
    cropRect = null;
    canvasRecadrageEl.querySelectorAll('.rect-crop').forEach(el => el.remove());
    const img = document.getElementById('imgRecadrage');
    img.onload = () => {
        imgRecadrageNaturalW = img.naturalWidth;
        imgRecadrageNaturalH = img.naturalHeight;
    };
    img.src = dataUrlOriginal;
    afficherVue('recadrage');
}

function posRelativeCrop(e) {
    const c = (e.touches && e.touches.length > 0) ? e.touches[0]
        : (e.changedTouches && e.changedTouches.length > 0) ? e.changedTouches[0] : e;
    const img = document.getElementById('imgRecadrage');
    const rect = img.getBoundingClientRect();
    return { x: c.clientX - rect.left, y: c.clientY - rect.top, canvasW: rect.width, canvasH: rect.height };
}

function handleStartCrop(e) {
    if (e.type === 'touchstart') e.preventDefault();
    canvasRecadrageEl.querySelectorAll('.rect-crop').forEach(el => el.remove());
    const p = posRelativeCrop(e);
    startXCrop = p.x; startYCrop = p.y; drawingCrop = true;
    currentRectCrop = document.createElement('div');
    currentRectCrop.className = 'rect-crop';
    currentRectCrop.style.left = startXCrop + 'px';
    currentRectCrop.style.top = startYCrop + 'px';
    canvasRecadrageEl.appendChild(currentRectCrop);
}

function handleMoveCrop(e) {
    if (!drawingCrop || !currentRectCrop) return;
    if (e.type === 'touchmove') e.preventDefault();
    const p = posRelativeCrop(e);
    const w = p.x - startXCrop, h = p.y - startYCrop;
    currentRectCrop.style.left = (w < 0 ? p.x : startXCrop) + 'px';
    currentRectCrop.style.top = (h < 0 ? p.y : startYCrop) + 'px';
    currentRectCrop.style.width = Math.abs(w) + 'px';
    currentRectCrop.style.height = Math.abs(h) + 'px';
}

function handleEndCrop(e) {
    if (!drawingCrop || !currentRectCrop) { drawingCrop = false; return; }
    drawingCrop = false;
    const p = posRelativeCrop(e);
    const w = p.x - startXCrop, h = p.y - startYCrop;
    const x = w < 0 ? p.x : startXCrop, y = h < 0 ? p.y : startYCrop;
    const width = Math.abs(w), height = Math.abs(h);
    if (width < 12 || height < 12) {
        currentRectCrop.remove();
        currentRectCrop = null;
        cropRect = null;
        return;
    }
    cropRect = {
        xPct: (x / p.canvasW) * 100,
        yPct: (y / p.canvasH) * 100,
        wPct: (width / p.canvasW) * 100,
        hPct: (height / p.canvasH) * 100
    };
}

canvasRecadrageEl.addEventListener('mousedown', handleStartCrop);
canvasRecadrageEl.addEventListener('mousemove', handleMoveCrop);
window.addEventListener('mouseup', handleEndCrop);
canvasRecadrageEl.addEventListener('touchstart', handleStartCrop, { passive: false });
canvasRecadrageEl.addEventListener('touchmove', handleMoveCrop, { passive: false });
window.addEventListener('touchend', handleEndCrop);

function reinitialiserCadrage() {
    cropRect = null;
    canvasRecadrageEl.querySelectorAll('.rect-crop').forEach(el => el.remove());
}

function appliquerCadrageEtStocker(callback) {
    const img = document.getElementById('imgRecadrage');

    // Si l'image n'est pas encore chargée (tap rapide sur "Image entière"), on attend.
    function faireCadrage() {
        const nW = img.naturalWidth, nH = img.naturalHeight;
        if (!nW || !nH) {
            // Sécurité : si toujours 0 après chargement, on utilise les dimensions affichées
            imgRecadrageNaturalW = nW || img.width;
            imgRecadrageNaturalH = nH || img.height;
        }
        let sx = 0, sy = 0, sw = imgRecadrageNaturalW, sh = imgRecadrageNaturalH;
        if (cropRect) {
            sx = cropRect.xPct / 100 * imgRecadrageNaturalW;
            sy = cropRect.yPct / 100 * imgRecadrageNaturalH;
            sw = cropRect.wPct / 100 * imgRecadrageNaturalW;
            sh = cropRect.hPct / 100 * imgRecadrageNaturalH;
        }
        if (!sw || !sh) { sw = imgRecadrageNaturalW; sh = imgRecadrageNaturalH; sx = 0; sy = 0; }
        const maxW = 1280;
        let w = sw, h = sh;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
        callback(c.toDataURL('image/jpeg', 0.82));
    }

    if (img.complete && img.naturalWidth > 0) {
        imgRecadrageNaturalW = img.naturalWidth;
        imgRecadrageNaturalH = img.naturalHeight;
        faireCadrage();
    } else {
        const ancienOnload = img.onload;
        img.onload = () => {
            imgRecadrageNaturalW = img.naturalWidth;
            imgRecadrageNaturalH = img.naturalHeight;
            if (ancienOnload) ancienOnload();
            faireCadrage();
        };
    }
}

let _recadrageCallback = null;

function ouvrirRecadrageAvecCallback(dataUrlOriginal, callback) {
    _recadrageCallback = callback;
    ouvrirRecadrage(dataUrlOriginal);
}

function validerCadrage() {
    const cb = _recadrageCallback;
    _recadrageCallback = null;
    appliquerCadrageEtStocker((dataUrlFinal) => {
        afficherVue('edition');
        if (cb) {
            cb(dataUrlFinal);
        } else {
            ajouterPageDepuisImage(dataUrlFinal);
        }
    });
}

function passerCadrage() {
    cropRect = null;
    validerCadrage();
}

function annulerCadrage() {
    afficherVue('edition');
    chargerCanvasEdition();
}

function appliquerZoom() {
    const img = canvasEl.querySelector('img');
    if (!img || !imgNaturalW) return;
    img.style.width = (imgNaturalW * zoomLevel) + 'px';
    img.style.height = 'auto';
    document.getElementById('zoomLabel').textContent = Math.round(zoomLevel * 100) + '%';
    document.getElementById('zoomSlider').value = Math.round(zoomLevel * 100);
    redessinerZonesEdition();
}
function zoomIn() { if (!imgNaturalW) return; zoomLevel = Math.min(3, zoomLevel + 0.01); appliquerZoom(); }
function zoomOut() { if (!imgNaturalW) return; zoomLevel = Math.max(0.15, zoomLevel - 0.01); appliquerZoom(); }
function zoomDepuisCurseur(valeurPourcent) { if (!imgNaturalW) return; zoomLevel = Math.max(0.15, Math.min(3, valeurPourcent / 100)); appliquerZoom(); }
function zoomReset() {
    if (!imgNaturalW) return;
    const wrapper = document.querySelector('.wrapper-canvas') || canvasEl.parentElement;
    const largeurDispo = wrapper ? wrapper.clientWidth : window.innerWidth * 0.9;
    const maxL = Math.min(largeurDispo, 1280);
    zoomLevel = Math.min(1, maxL / imgNaturalW);
    appliquerZoom();
}

function posRelative(e) {
    const c = (e.touches && e.touches.length > 0) ? e.touches[0]
        : (e.changedTouches && e.changedTouches.length > 0) ? e.changedTouches[0] : e;
    const imgEl = canvasEl.querySelector('img');
    const rect = (imgEl || canvasEl).getBoundingClientRect();
    return { x: c.clientX - rect.left, y: c.clientY - rect.top, canvasW: rect.width, canvasH: rect.height };
}

let formeActuelle = 'rect';
let cheminLibre = [];
let svgApercu = null;

function choisirForme(forme) {
    formeActuelle = forme;
    document.querySelectorAll('.forme-btn').forEach(b => b.classList.toggle('actif', b.dataset.forme === forme));
}

function handleStart(e) {
    if (!canvasEl.querySelector('img')) return;
    if (e.target && e.target.closest && e.target.closest('.rect-label')) return;
    if (e.type === 'touchstart') {
        e.preventDefault();
        if (e.touches.length >= 2) return; // on ignore le multi-doigts : zoom uniquement via les boutons
    }
    const p = posRelative(e);
    startX = p.x; startY = p.y; drawing = true;

    if (formeActuelle === 'libre') {
        cheminLibre = [{ x: p.x, y: p.y }];
        svgApercu = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svgApercu.classList.add('rect');
        svgApercu.style.position = 'absolute';
        svgApercu.style.left = '0'; svgApercu.style.top = '0';
        svgApercu.style.width = '100%'; svgApercu.style.height = '100%';
        svgApercu.style.pointerEvents = 'none';
        svgApercu.style.border = 'none'; svgApercu.style.background = 'transparent';
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        poly.setAttribute('fill', 'rgba(52,152,219,0.2)');
        poly.setAttribute('stroke', '#3498db');
        poly.setAttribute('stroke-width', '2');
        svgApercu.appendChild(poly);
        canvasEl.appendChild(svgApercu);
        return;
    }

    currentRect = document.createElement('div');
    currentRect.className = 'rect';
    if (formeActuelle === 'ellipse') currentRect.style.borderRadius = '50%';
    currentRect.style.left = startX + 'px';
    currentRect.style.top = startY + 'px';
    canvasEl.appendChild(currentRect);
}

function handleMove(e) {
    if (e.type === 'touchmove' && e.touches.length >= 2) { e.preventDefault(); return; }
    if (!drawing) return;
    if (e.type === 'touchmove') e.preventDefault();
    const p = posRelative(e);

    if (formeActuelle === 'libre') {
        if (!svgApercu) return;
        const dernier = cheminLibre[cheminLibre.length - 1];
        const dist = Math.hypot(p.x - dernier.x, p.y - dernier.y);
        if (dist >= 4) cheminLibre.push({ x: p.x, y: p.y });
        svgApercu.querySelector('polygon').setAttribute('points', cheminLibre.map(pt => pt.x + ',' + pt.y).join(' '));
        return;
    }

    if (!currentRect) return;
    const w = p.x - startX, h = p.y - startY;
    currentRect.style.left = (w < 0 ? p.x : startX) + 'px';
    currentRect.style.top = (h < 0 ? p.y : startY) + 'px';
    currentRect.style.width = Math.abs(w) + 'px';
    currentRect.style.height = Math.abs(h) + 'px';
}

function handleEnd(e) {
    if (!drawing) { return; }
    drawing = false;
    const p = posRelative(e);

    if (formeActuelle === 'libre') {
        if (svgApercu) { svgApercu.remove(); svgApercu = null; }
        const xs = cheminLibre.map(pt => pt.x), ys = cheminLibre.map(pt => pt.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const largeur = maxX - minX, hauteur = maxY - minY;

        if (largeur <= CLICK_THRESHOLD && hauteur <= CLICK_THRESHOLD) {
            supprimerZoneAuPoint((p.x / p.canvasW) * 100, (p.y / p.canvasH) * 100);
            cheminLibre = [];
            return;
        }

        const pointsRelatifs = cheminLibre.map(pt => ({
            x: ((pt.x - minX) / largeur) * 100,
            y: ((pt.y - minY) / hauteur) * 100
        }));

        pageEnCours().zones.push({
            forme: 'libre',
            xPct: (minX / p.canvasW) * 100,
            yPct: (minY / p.canvasH) * 100,
            wPct: (largeur / p.canvasW) * 100,
            hPct: (hauteur / p.canvasH) * 100,
            points: pointsRelatifs,
            indice: ''
        });
        cheminLibre = [];
        redessinerZonesEdition();
        majCompteurZonesEdition();
        sauvegarderSupports();
        return;
    }

    if (!currentRect) return;
    const w = p.x - startX, h = p.y - startY;
    const x = w < 0 ? p.x : startX, y = h < 0 ? p.y : startY;
    const width = Math.abs(w), height = Math.abs(h);

    if (width <= CLICK_THRESHOLD && height <= CLICK_THRESHOLD) {
        currentRect.remove(); currentRect = null;
        supprimerZoneAuPoint((x / p.canvasW) * 100, (y / p.canvasH) * 100);
        return;
    }

    pageEnCours().zones.push({
        forme: formeActuelle,
        xPct: (x / p.canvasW) * 100,
        yPct: (y / p.canvasH) * 100,
        wPct: (width / p.canvasW) * 100,
        hPct: (height / p.canvasH) * 100,
        indice: ''
    });
    currentRect.remove(); currentRect = null;
    redessinerZonesEdition();
    majCompteurZonesEdition();
    sauvegarderSupports();
}

canvasEl.addEventListener('mousedown', handleStart);
canvasEl.addEventListener('mousemove', handleMove);
window.addEventListener('mouseup', handleEnd);
canvasEl.addEventListener('touchstart', handleStart, { passive: false });
canvasEl.addEventListener('touchmove', handleMove, { passive: false });
window.addEventListener('touchend', handleEnd);

window.addEventListener('resize', () => {
    if (vueActuelle === 'edition' && supportActif) redessinerZonesEdition();
});

window.addEventListener('keydown', (e) => {
    if (vueActuelle !== 'edition') return;
    const touche = e.key ? e.key.toLowerCase() : '';
    if ((e.ctrlKey || e.metaKey) && touche === 'z') { e.preventDefault(); effacerDerniereZone(); }
});

function supprimerZoneAuPoint(xPct, yPct) {
    const zones = pageEnCours().zones;
    for (let i = zones.length - 1; i >= 0; i--) {
        const z = zones[i];
        if (xPct >= z.xPct && xPct <= z.xPct + z.wPct && yPct >= z.yPct && yPct <= z.yPct + z.hPct) {
            zones.splice(i, 1);
            redessinerZonesEdition();
            majCompteurZonesEdition();
            sauvegarderSupports();
            return;
        }
    }
}

function effacerDerniereZone() {
    if (!supportActif || pageEnCours().zones.length === 0) return;
    pageEnCours().zones.pop();
    redessinerZonesEdition();
    majCompteurZonesEdition();
    sauvegarderSupports();
}

function effacerToutesZones() {
    if (!supportActif) return;
    pageEnCours().zones = [];
    redessinerZonesEdition();
    majCompteurZonesEdition();
    sauvegarderSupports();
}

function redessinerZonesEdition() {
    canvasEl.querySelectorAll('.rect').forEach(el => el.remove());
    const imgEl = canvasEl.querySelector('img');
    if (!imgEl) return;
    const rect = imgEl.getBoundingClientRect();
    const rectCanvas = canvasEl.getBoundingClientRect();
    const decalX = rect.left - rectCanvas.left;
    const decalY = rect.top - rectCanvas.top;
    pageEnCours().zones.forEach((z, i) => {
        const left = decalX + z.xPct / 100 * rect.width;
        const top = decalY + z.yPct / 100 * rect.height;
        const largeur = z.wPct / 100 * rect.width;
        const hauteur = z.hPct / 100 * rect.height;

        // Couleur distinctive par zone
        const couleur = COULEURS_ZONES[i % COULEURS_ZONES.length];

        const conteneur = document.createElement('div');
        conteneur.className = 'rect';
        conteneur.style.left = left + 'px';
        conteneur.style.top = top + 'px';
        conteneur.style.width = largeur + 'px';
        conteneur.style.height = hauteur + 'px';
        conteneur.style.borderColor = couleur.bord;
        conteneur.style.background = couleur.fond;

        if (z.forme === 'libre' && z.points) {
            conteneur.style.border = 'none';
            conteneur.style.background = 'transparent';
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 100 100');
            svg.setAttribute('preserveAspectRatio', 'none');
            svg.style.width = '100%';
            svg.style.height = '100%';
            svg.style.display = 'block';
            const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            poly.setAttribute('points', z.points.map(p => p.x + ',' + p.y).join(' '));
            poly.setAttribute('fill', couleur.fond.replace('0.06', '0.2'));
            poly.setAttribute('stroke', couleur.bord);
            poly.setAttribute('stroke-width', '2');
            poly.setAttribute('vector-effect', 'non-scaling-stroke');
            svg.appendChild(poly);
            conteneur.appendChild(svg);
        } else if (z.forme === 'ellipse') {
            conteneur.style.borderRadius = '50%';
        }

        const label = document.createElement('span');
        label.className = 'rect-label' + (z.indice ? ' a-un-indice' : '');
        label.textContent = i + 1;
        label.style.background = couleur.bord;
        label.style.color = '#fff';
        label.style.borderColor = couleur.bord;
        label.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ouvrirBulleIndice(label, i);
        });
        conteneur.appendChild(label);
        canvasEl.appendChild(conteneur);
    });
}

function majCompteurZonesEdition() {
    if (!supportActif) return;
    const n = pageEnCours().zones.length;
    document.getElementById('compteurZonesEdition').textContent = n + ' zone' + (n === 1 ? '' : 's');
    const btnRev = document.getElementById('btnReviserMaintenant');
    if (btnRev) btnRev.style.display = n > 0 ? '' : 'none';
}

function echapperHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Bulle d'édition d'indice, ancrée près de la zone tapée plutôt qu'une grosse modale */
let bulleIndiceEl = null;

function fermerBulleIndice() {
    if (bulleIndiceEl) {
        if (bulleIndiceEl._repositionner && window.visualViewport) {
            window.visualViewport.removeEventListener('resize', bulleIndiceEl._repositionner);
            window.visualViewport.removeEventListener('scroll', bulleIndiceEl._repositionner);
        }
        bulleIndiceEl.remove();
        bulleIndiceEl = null;
    }
    document.removeEventListener('click', fermerBulleIndiceSiExterieur, true);
}

function fermerBulleIndiceSiExterieur(ev) {
    if (bulleIndiceEl && !bulleIndiceEl.contains(ev.target)) fermerBulleIndice();
}

function ouvrirBulleIndice(labelEl, idxZone) {
    fermerBulleIndice();
    const z = pageEnCours().zones[idxZone];
    const rectLabel = labelEl.getBoundingClientRect();

    bulleIndiceEl = document.createElement('div');
    bulleIndiceEl.className = 'bulle-indice-edition';
    bulleIndiceEl.innerHTML = `
        <div class="titre">💡 Indice — zone ${idxZone + 1}</div>
        <div style="display:flex;gap:6px;align-items:center;">
            <input type="text" id="champBulleIndice" placeholder="Ex : verbe, commence par É..." style="flex:1;width:auto;">
            <button type="button" class="btn-media btn-dictee" id="btnDicteeBulleIndice" title="Dicter au micro">🎤</button>
        </div>
        <div class="actions">
            <button class="btn-modal annuler" id="btnSupprBulleIndice">Effacer</button>
            <button class="btn-modal enregistrer" id="btnOkBulleIndice">OK</button>
        </div>`;
    document.body.appendChild(bulleIndiceEl);

    // Positionnement : sous le badge par défaut, au-dessus si pas assez de place,
    // recalculé en continu selon la zone réellement visible (le clavier réduit cette zone sur iPad).
    const largeurBulle = 240;
    function repositionnerBulleIndice() {
        if (!bulleIndiceEl) return;
        const vh = (window.visualViewport ? window.visualViewport.height : window.innerHeight);
        const vw = (window.visualViewport ? window.visualViewport.width : window.innerWidth);
        const hauteurBulle = bulleIndiceEl.offsetHeight || 130;
        let left = rectLabel.left;
        let top = rectLabel.bottom + 8;
        if (left + largeurBulle > vw - 10) left = vw - largeurBulle - 10;
        if (left < 10) left = 10;
        if (top + hauteurBulle > vh - 10) top = rectLabel.top - hauteurBulle - 8;
        if (top < 10) top = 10; // si même au-dessus ça ne rentre pas, on colle en haut de la zone visible
        if (top + hauteurBulle > vh - 10) top = Math.max(10, vh - hauteurBulle - 10);
        bulleIndiceEl.style.left = left + 'px';
        bulleIndiceEl.style.top = top + 'px';
    }
    repositionnerBulleIndice();
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', repositionnerBulleIndice);
        window.visualViewport.addEventListener('scroll', repositionnerBulleIndice);
    }
    bulleIndiceEl._repositionner = repositionnerBulleIndice;

    const champ = document.getElementById('champBulleIndice');
    champ.value = z.indice || '';
    champ.focus();
    // Après l'ouverture du clavier (animation ~300ms sur iOS), on recale une dernière fois.
    setTimeout(repositionnerBulleIndice, 350);

    function valider() {
        pageEnCours().zones[idxZone].indice = champ.value.trim();
        sauvegarderSupports();
        redessinerZonesEdition();
        fermerBulleIndice();
    }
    document.getElementById('btnDicteeBulleIndice').addEventListener('click', (ev) => {
        ev.stopPropagation();
        demarrerDictee(champ, ev.currentTarget);
    });
    document.getElementById('btnOkBulleIndice').addEventListener('click', (ev) => { ev.stopPropagation(); valider(); });
    document.getElementById('btnSupprBulleIndice').addEventListener('click', (ev) => {
        ev.stopPropagation();
        champ.value = '';
        valider();
    });
    champ.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') valider(); });
    bulleIndiceEl.addEventListener('click', (ev) => ev.stopPropagation());

    setTimeout(() => document.addEventListener('click', fermerBulleIndiceSiExterieur, true), 0);
}

/* ---------------- Révision (Leitner) — agrégée sur toutes les pages d'un support image ---------------- */

function localeDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const j = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${j}`;
}
function todayStr() { return localeDateStr(new Date()); }
function addDays(s, n) { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return localeDateStr(d); }
function estDue(cle) { return etatRevision[cle].nextDue <= todayStr(); }

function initEtatRevisionImage() {
    etatRevision = supportActif.etat || (supportActif.etat = {});
    supportActif.pages.forEach((page, pi) => {
        page.zones.forEach((z, zi) => {
            const cle = pi + '_' + zi;
            if (!etatRevision[cle]) etatRevision[cle] = { box: 1, nextDue: todayStr(), indicePerso: '' };
            if (etatRevision[cle].indicePerso === undefined) etatRevision[cle].indicePerso = '';
        });
    });
    sauvegarderSupports();
}

function construireVueRevision() {
    initEtatRevisionImage();

    const mode = supportActif.mode || 'simple';
    document.body.classList.toggle('mode-simple', mode === 'simple');
    const segmenteBtns = document.querySelectorAll('#segmente .mode-btn');
    segmenteBtns.forEach(b => b.classList.toggle('actif', b.dataset.mode === mode));
    const segmenteThumb = document.querySelector('#segmente .thumb');
    if (segmenteThumb) segmenteThumb.classList.toggle('pos-1', mode === 'complet');
    document.body.classList.remove('filtre-actif');
    const btnFiltre = document.getElementById('btnFiltre');
    if (btnFiltre) btnFiltre.textContent = '📅 Zones dues';

    chargerPageRevision();
}

function pagePrecedenteRevision() {
    if (pageActuelle > 0) { pageActuelle--; chargerPageRevision(); }
}
function pageSuivanteRevision() {
    if (pageActuelle < supportActif.pages.length - 1) { pageActuelle++; chargerPageRevision(); }
}

function chargerPageRevision() {
    try {
    const page = supportActif.pages[pageActuelle];
    const conteneur = document.getElementById('conteneurImage');
    conteneur.innerHTML = '';
    const img = document.createElement('img');
    img.src = page.image;
    img.style.display = 'block';
    img.style.maxWidth = '100%';
    if (!page.image) {
        conteneur.innerHTML = '<div style="padding:40px;color:#999;text-align:center;">⚠️ Image absente — essaie de réimporter ce support.</div>';
        majNavigateurPages('revision');
        return;
    }
    conteneur.appendChild(img);

    page.zones.forEach((z, i) => {
        const cle = pageActuelle + '_' + i;
        const masque = document.createElement('div');
        masque.className = 'masque';
        masque.dataset.cle = cle;
        masque.style.left = z.xPct + '%';
        masque.style.top = z.yPct + '%';
        masque.style.width = z.wPct + '%';
        masque.style.height = z.hPct + '%';
        masque.addEventListener('click', () => toggleRevele(masque));

        // Couleur distinctive par zone (palette iOS)
        const couleur = COULEURS_ZONES[i % COULEURS_ZONES.length];

        const fond = document.createElement('div');
        fond.className = 'fond';
        fond.style.background = '#fff';
        fond.style.borderColor = couleur.bord;
        fond.style.borderWidth = '2.5px';
        if (z.forme === 'ellipse') {
            fond.style.borderRadius = '50%';
        } else if (z.forme === 'libre' && z.points) {
            fond.style.clipPath = 'polygon(' + z.points.map(p => p.x + '% ' + p.y + '%').join(',') + ')';
            fond.style.borderRadius = '0';
        }
        masque.appendChild(fond);

        const niveau = document.createElement('div');
        niveau.className = 'boite-niveau';
        masque.appendChild(niveau);

        const indiceBtn = document.createElement('div');
        indiceBtn.className = 'indice-btn';
        indiceBtn.textContent = '💡';
        indiceBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            // Fermer tous les autres panneaux ouverts avant d'ouvrir celui-ci
            const etaitActif = masque.classList.contains('indice-actif');
            document.querySelectorAll('#conteneurImage .masque.indice-actif').forEach(m => m.classList.remove('indice-actif'));
            if (!etaitActif) masque.classList.add('indice-actif');
        });
        masque.appendChild(indiceBtn);

        const panel = document.createElement('div');
        panel.className = 'indice-panel' + (z.yPct < 12 ? ' dessous' : '');
        panel.addEventListener('click', (ev) => ev.stopPropagation());
        if (z.indice) {
            const indiceFiche = document.createElement('div');
            indiceFiche.className = 'indice-prof';
            indiceFiche.textContent = '💡 ' + z.indice;
            panel.appendChild(indiceFiche);
        }
        const labelPerso = document.createElement('span');
        labelPerso.className = 'indice-perso-label';
        labelPerso.textContent = '✏️ Mon indice personnel';
        panel.appendChild(labelPerso);
        const inputPerso = document.createElement('input');
        inputPerso.type = 'text';
        inputPerso.className = 'indice-perso-input';
        inputPerso.placeholder = 'Ex : ça me fait penser à...';
        inputPerso.value = etatRevision[cle].indicePerso || '';
        inputPerso.addEventListener('input', () => { etatRevision[cle].indicePerso = inputPerso.value; sauvegarderSupportsDifferee(); });
        panel.appendChild(inputPerso);

        // Bouton enregistrement vocal
        const audioRow = document.createElement('div');
        audioRow.className = 'indice-audio-row';
        audioRow.style.marginTop = '6px';

        const btnEnr = document.createElement('button');
        btnEnr.className = 'indice-audio-btn';
        btnEnr.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Enregistrer';
        audioRow.appendChild(btnEnr);

        const lecteur = document.createElement('audio');
        lecteur.style.cssText = 'height:24px;width:100%;display:none;margin-top:4px;';
        lecteur.controls = true;
        audioRow.appendChild(lecteur);

        const btnSuppAudio = document.createElement('button');
        btnSuppAudio.className = 'indice-audio-del';
        btnSuppAudio.textContent = '🗑';
        btnSuppAudio.style.display = 'none';
        audioRow.appendChild(btnSuppAudio);

        // Charger l'audio existant — seulement si une vraie donnée est stockée
        const audioExistant = etatRevision[cle].indicePersoAudio;
        if (audioExistant && audioExistant.length > 100) {
            lecteur.src = audioExistant;
            lecteur.style.display = '';
            btnSuppAudio.style.display = '';
        }

        let enrZone = false;
        let mrZone = null;
        let chunksZone = [];

        btnEnr.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (enrZone) {
                if (mrZone && mrZone.state === 'recording') mrZone.stop();
                return;
            }
            if (!navigator.mediaDevices) { alert("Micro non disponible."); return; }
            navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
                chunksZone = [];
                const opts = MediaRecorder.isTypeSupported('audio/mp4') ? { mimeType:'audio/mp4' } :
                             MediaRecorder.isTypeSupported('audio/webm') ? { mimeType:'audio/webm' } : {};
                mrZone = new MediaRecorder(stream, opts);
                mrZone.ondataavailable = e => { if (e.data.size > 0) chunksZone.push(e.data); };
                mrZone.onstop = () => {
                    stream.getTracks().forEach(t => t.stop());
                    const blob = new Blob(chunksZone, { type: mrZone.mimeType });
                    const reader = new FileReader();
                    reader.onload = ev2 => {
                        etatRevision[cle].indicePersoAudio = ev2.target.result;
                        sauvegarderSupports();
                        lecteur.src = ev2.target.result;
                        lecteur.style.display = '';
                        btnSuppAudio.style.display = '';
                    };
                    reader.readAsDataURL(blob);
                    enrZone = false;
                    btnEnr.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Enregistrer';
                    btnEnr.classList.remove('enregistrement');
                };
                mrZone.start();
                enrZone = true;
                btnEnr.textContent = '⏹ Arrêter';
                btnEnr.classList.add('enregistrement');
            }).catch(() => alert("Impossible d'accéder au microphone."));
        });

        btnSuppAudio.addEventListener('click', (ev) => {
            ev.stopPropagation();
            delete etatRevision[cle].indicePersoAudio;
            sauvegarderSupports();
            lecteur.src = '';
            lecteur.style.display = 'none';
            btnSuppAudio.style.display = 'none';
        });

        panel.appendChild(audioRow);
        masque.appendChild(panel);

        const declare = document.createElement('div');
        declare.className = 'declare' + (z.yPct < 12 ? ' dessous' : '');
        declare.addEventListener('click', (ev) => ev.stopPropagation());
        const btnOk = document.createElement('button');
        btnOk.className = 'btn-ok';
        btnOk.textContent = '✓';
        btnOk.addEventListener('click', (ev) => { ev.stopPropagation(); declarer(masque, 'oui'); });
        const btnMoyen = document.createElement('button');
        btnMoyen.className = 'btn-moyen';
        btnMoyen.textContent = '〜';
        btnMoyen.style.cssText = 'background:#FF9500;color:#fff;';
        btnMoyen.addEventListener('click', (ev) => { ev.stopPropagation(); declarer(masque, 'moyen'); });
        const btnNon = document.createElement('button');
        btnNon.className = 'btn-non';
        btnNon.textContent = '✗';
        btnNon.addEventListener('click', (ev) => { ev.stopPropagation(); declarer(masque, 'non'); });
        declare.appendChild(btnOk);
        declare.appendChild(btnMoyen);
        declare.appendChild(btnNon);
        masque.appendChild(declare);

        conteneur.appendChild(masque);
    });

    majNavigateurPages('revision');
    actualiserAffichageRevision();
    } catch(e) {
        console.error('Erreur révision image:', e.message);
    }
}

function toggleRevele(masque) { masque.classList.toggle('revele'); }

function afficherToastMsg(msg, duree) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMsg');
    if (!toast || !toastMsg) return;
    toastMsg.textContent = msg;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), duree || 3000);
}

function afficherToast(bon, total) {
    const bonnes = document.querySelectorAll('#conteneurImage .masque.correcte').length;
    const mauvaises = document.querySelectorAll('#conteneurImage .masque.incorrecte').length;
    const toast = document.getElementById('toast');
    document.getElementById('toastMsg').textContent = bon ? '✅ Bonne réponse !' : '❌ À revoir !';
    document.getElementById('toastScore').textContent = bonnes + ' ✅  /  ' + mauvaises + ' ❌  (sur ' + total + ')';
    toast.classList.remove('bonne', 'mauvaise');
    toast.classList.add(bon ? 'bonne' : 'mauvaise');
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
}

function declarer(masque, resultat) {
    const bon = resultat === 'oui' || resultat === true;
    const moyen = resultat === 'moyen';
    masque.classList.remove('correcte', 'incorrecte', 'moyenne');
    masque.classList.add(bon ? 'correcte' : moyen ? 'moyenne' : 'incorrecte');
    const cle = masque.dataset.cle;
    majEchecsConsecutifs(etatRevision[cle], bon || moyen);
    const qualiteZone = bon ? 5 : moyen ? 4 : 0;
    appliquerSM2(etatRevision[cle], qualiteZone);
    sauvegarderSupports();
    majCompteurRevision();
    haptic(bon ? 'success' : moyen ? 'light' : 'error');
    afficherToast(bon, document.querySelectorAll('#conteneurImage .masque').length);
    actualiserAffichageRevision();
}

function actualiserAffichageRevision() {
    document.querySelectorAll('#conteneurImage .masque').forEach(m => {
        const cle = m.dataset.cle;
        const e = etatRevision[cle];
        if (!e) return;
        const niveau = m.querySelector('.boite-niveau');
        if (niveau) { niveau.textContent = e.box; niveau.className = 'boite-niveau niveau-' + e.box; }
        m.classList.toggle('due', estDue(cle));
        m.classList.toggle('difficile', !!e.difficile);

        // ✓ sur le bouton 💡 si la zone est maîtrisée (boîte 4 ou 5)
        const btnIndice = m.querySelector('.indice-btn, button[title]');
        if (btnIndice) {
            const maitrisee = e.box >= 4;
            btnIndice.textContent = maitrisee ? '💡✓' : '💡';
            btnIndice.style.opacity = maitrisee ? '0.6' : '1';
        }
    });
    majCompteurRevision();
    actualiserResumeBoites();
}

function htmlStatsVisuelles(counts, total, duesTotal, unite) {
    const aretravailler = (counts[0] || 0) + (counts[1] || 0);
    const enCours = counts[2] || 0;
    const maitrise = (counts[3] || 0) + (counts[4] || 0);
    const pctM = total ? Math.round(maitrise / total * 100) : 0;
    const pctC = total ? Math.round(enCours / total * 100) : 0;
    const pctR = total ? 100 - pctM - pctC : 0;
    return '<div class="stats-visuelles">'
        + '<div class="stats-barre">'
        + (pctM > 0 ? '<div class="stats-seg stats-maitrise" style="width:' + pctM + '%"></div>' : '')
        + (pctC > 0 ? '<div class="stats-seg stats-encours" style="width:' + pctC + '%"></div>' : '')
        + (pctR > 0 ? '<div class="stats-seg stats-retravailler" style="width:' + pctR + '%"></div>' : '')
        + '</div>'
        + '<div class="stats-legende">'
        + '<span class="stats-item"><span class="stats-puce stats-maitrise"></span> Maîtrisé ' + maitrise + '/' + total + '</span>'
        + '<span class="stats-item"><span class="stats-puce stats-encours"></span> En cours ' + enCours + '</span>'
        + '<span class="stats-item"><span class="stats-puce stats-retravailler"></span> À retravailler ' + aretravailler + '</span>'
        + '</div>'
        + (duesTotal > 0
            ? '<div class="stats-due">📅 ' + duesTotal + ' ' + unite + ' à réviser aujourd\'hui</div>'
            : '<div class="stats-due" style="color:#34C759;">✅ Rien à réviser aujourd\'hui !</div>')
        + '</div>';
}

function actualiserResumeBoitesImage() {
    const counts = [0, 0, 0, 0, 0];
    let total = 0, duesTotal = 0;
    if (!supportActif || !supportActif.pages) return;
    supportActif.pages.forEach((page, pi) => {
        page.zones.forEach((z, zi) => {
            const cle = pi + '_' + zi;
            const e = etatRevision && etatRevision[cle];
            if (!e) return;
            const b = Math.max(1, Math.min(5, e.box || 1));
            counts[b - 1]++;
            total++;
            if (estDue(cle)) duesTotal++;
        });
    });
    const el = document.getElementById('resumeBoites');
    if (el) el.innerHTML = htmlStatsVisuelles(counts, total, duesTotal, 'zone(s)');
}

function actualiserResumeBoites() { actualiserResumeBoitesImage(); }

function majCompteurRevision() {
    const total = document.querySelectorAll('#conteneurImage .masque').length;
    const bonnes = document.querySelectorAll('#conteneurImage .masque.correcte').length;
    const mauvaises = document.querySelectorAll('#conteneurImage .masque.incorrecte').length;
    const fragiles = document.querySelectorAll('#conteneurImage .masque.moyenne').length;
    const suffixe = supportActif.pages.length > 1 ? ' zones, cette page)' : ' zones, cette session)';
    const el = document.getElementById('compteurRevision');
    if (!el) return;
    let txt = '✅ ' + bonnes + '   ❌ ' + mauvaises;
    if (fragiles > 0) txt += '   <span style="color:#FF9500;font-weight:600;">〜 ' + fragiles + ' fragile' + (fragiles > 1 ? 's' : '') + '</span>';
    txt += '   (sur ' + total + suffixe;
    el.innerHTML = txt;
}

function remasquerToutRevision() {
    document.querySelectorAll('#conteneurImage .masque').forEach(m => {
        m.classList.remove('revele', 'correcte', 'incorrecte', 'moyenne');
    });
    majCompteurRevision();
    actualiserAffichageRevision();
}

function basculerFiltre() {
    document.body.classList.toggle('filtre-actif');
    const actif = document.body.classList.contains('filtre-actif');
    document.getElementById('btnFiltre').textContent = actif ? '👀 Tout afficher' : '📅 Zones à réviser';
}

function reinitialiserProgression() {
    if (!confirm('Effacer toute ta progression sur ce support (y compris tes indices personnels) ? Cette action est irréversible.')) return;
    supportActif.etat = {};
    supportActif.pages.forEach((page, pi) => {
        page.zones.forEach((z, zi) => {
            supportActif.etat[pi + '_' + zi] = { box: 1, nextDue: todayStr(), indicePerso: '' };
        });
    });
    etatRevision = supportActif.etat;
    sauvegarderSupports();
    document.querySelectorAll('#conteneurImage .masque').forEach(m => {
        m.classList.remove('revele', 'correcte', 'incorrecte', 'indice-actif');
        const inp = m.querySelector('.indice-perso-input');
        if (inp) inp.value = '';
    });
    actualiserAffichageRevision();
}

function changerMode(mode) {
    supportActif.mode = mode;
    document.body.classList.toggle('mode-simple', mode === 'simple');
    document.querySelectorAll('#segmente .mode-btn').forEach(b => b.classList.toggle('actif', b.dataset.mode === mode));
    const thumb = document.querySelector('#segmente .thumb');
    if (thumb) thumb.classList.toggle('pos-1', mode === 'complet');
    if (mode === 'simple') {
        document.body.classList.remove('filtre-actif');
        const btnFiltre = document.getElementById('btnFiltre');
        if (btnFiltre) btnFiltre.textContent = '📅 Zones à réviser';
    }
    sauvegarderSupports();
}

/* ── Utilitaire : compression image ── */
function compresserImageFichier(file, maxW, qualite, callback) {
    const reader = new FileReader();
    reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
            let w = img.naturalWidth, h = img.naturalHeight;
            if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            callback(canvas.toDataURL('image/jpeg', qualite));
        };
        img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
}

/* ── Enregistrement audio par champ ── */
let mediaRecorder = null;
let audioChunks = [];
let enregistrementEnCours = { idx: null, champ: null };

function demarrerEnregistrement(idx, champ, btnEl) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("L'enregistrement audio n'est pas disponible sur cet appareil ou navigateur.");
        return;
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        arreterEnregistrement();
        return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        audioChunks = [];
        const options = MediaRecorder.isTypeSupported('audio/mp4') ? { mimeType: 'audio/mp4' } :
                        MediaRecorder.isTypeSupported('audio/webm') ? { mimeType: 'audio/webm' } : {};
        mediaRecorder = new MediaRecorder(stream, options);
        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = () => {
            const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
            stream.getTracks().forEach(t => t.stop());
            const reader = new FileReader();
            reader.onload = ev => {
                const cle = champ + 'Audio'; // questionAudio, reponseAudio, exempleAudio, indiceAudio
                supportActif.cartes[enregistrementEnCours.idx][cle] = ev.target.result;
                sauvegarderSupports();
                chargerEditionTexte();
            };
            reader.readAsDataURL(blob);
        };
        enregistrementEnCours = { idx, champ };
        mediaRecorder.start();
        if (btnEl) { btnEl.textContent = '⏹ Stop'; btnEl.classList.add('enregistrement'); }
    }).catch(() => alert("Impossible d'accéder au microphone."));
}

function arreterEnregistrement() {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
}

function supprimerAudio(idx, champ) {
    delete supportActif.cartes[idx][champ + 'Audio'];
    sauvegarderSupports();
    chargerEditionTexte();
}

/* ── Champ média (image + audio) ── */
function htmlChampMedia(c, i, champ, labelTexte, placeholder) {
    const cleImage = champ + 'Image';
    const cleAudio = champ + 'Audio';
    const hasImage = !!c[cleImage];
    const hasAudio = !!c[cleAudio];
    return `
    <div class="champ-carte">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <span class="label-modale" style="flex:1;">${labelTexte}</span>
            <label class="btn-media" title="Image">
                📷
                <input type="file" accept="image/*" class="input-image-champ" data-idx="${i}" data-champ="${champ}" style="display:none;">
            </label>
            <button class="btn-media btn-dictee" data-idx="${i}" data-champ="${champ}" onclick="demarrerDicteeChamp(this)" title="Dicter au micro">🎤</button>
            <button class="btn-media btn-audio-rec" data-idx="${i}" data-champ="${champ}" onclick="demarrerEnregistrement(${i},'${champ}',this)">🎙️</button>
        </div>
        <input type="text" class="champ-modale input-champ-texte" data-idx="${i}" data-champ="${champ}" value="${echapperHtml(c[champ] || '')}" placeholder="${placeholder}" style="margin-bottom:4px;">
        ${hasImage ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <img src="${c[cleImage]}" style="width:48px;height:48px;object-fit:cover;border-radius:8px;flex-shrink:0;">
            <button class="icon-btn danger" style="font-size:11px;" onclick="supprimerImageChamp(${i},'${champ}')">🗑 Image</button>
        </div>` : ''}
        ${hasAudio ? `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <audio src="${c[cleAudio]}" controls style="height:28px;flex:1;"></audio>
            <button class="icon-btn danger" style="font-size:11px;" onclick="supprimerAudio(${i},'${champ}')">🗑</button>
        </div>` : ''}
    </div>`;
}

/* ── Dictée vocale (reconnaissance vocale → remplit un champ texte) ── */
let reconnaissanceEnCours = null;

function langueDicteeSupport() {
    // La reconnaissance vocale ne connaît pas "la" (latin) : on retombe sur le français.
    const l = supportActif && supportActif.langue;
    return (l && l !== 'la') ? l : 'fr-FR';
}

function demarrerDictee(inputEl, btnEl) {
    if (!inputEl) return;
    // Un appui pendant que ça écoute déjà arrête la dictée en cours.
    if (reconnaissanceEnCours) {
        reconnaissanceEnCours.stop();
        return;
    }
    const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
        alert("La dictée vocale n'est pas disponible sur ce navigateur.");
        return;
    }
    const reco = new SpeechRecognitionAPI();
    reco.lang = langueDicteeSupport();
    reco.interimResults = false;
    reco.maxAlternatives = 1;

    const valeurDepart = inputEl.value || '';
    const prefixe = valeurDepart && !/\s$/.test(valeurDepart) ? valeurDepart + ' ' : valeurDepart;

    reco.onresult = (ev) => {
        let transcription = '';
        for (let i = 0; i < ev.results.length; i++) transcription += ev.results[i][0].transcript;
        inputEl.value = prefixe + transcription;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    };
    reco.onerror = (ev) => {
        if (ev.error !== 'aborted' && ev.error !== 'no-speech') {
            alert("La dictée vocale n'a pas pu démarrer (micro refusé ou indisponible).");
        }
    };
    reco.onend = () => {
        reconnaissanceEnCours = null;
        if (btnEl) btnEl.classList.remove('enregistrement');
    };

    try {
        reco.start();
        reconnaissanceEnCours = reco;
        if (btnEl) btnEl.classList.add('enregistrement');
    } catch (e) {
        alert("La dictée vocale n'a pas pu démarrer.");
    }
}

// Utilisé par les champs de carte (question/réponse/exemple/indice) :
// retrouve le champ texte voisin du bouton 🎤 dans sa carte.
function demarrerDicteeChamp(btnEl) {
    const conteneur = btnEl.closest('.champ-carte');
    const inputEl = conteneur ? conteneur.querySelector('.input-champ-texte') : null;
    demarrerDictee(inputEl, btnEl);
}

/* ── Édition des cartes ── */
function chargerEditionTexte() {
    document.getElementById('titreHeader').textContent = supportActif.nom;
    const conteneur = document.getElementById('listeCartesTexte');
    document.getElementById('champLangueSupport').value = supportActif.langue || 'fr-FR';
    remplirSelecteurVoix();

    if (supportActif.cartes.length === 0) {
        conteneur.innerHTML = '<div class="vide" style="padding:20px 10px;">Aucune carte pour l\'instant. Ajoute ta première question/réponse.</div>';
    } else {
        conteneur.innerHTML = supportActif.cartes.map((c, i) => `
            <div class="ligne-carte-texte">
                <div class="carte-texte-bandeau" style="background:${COULEURS_ZONES[i % COULEURS_ZONES.length].bord};">Carte ${i + 1}</div>
                <div class="champs-carte-empiles">
                    ${htmlChampMedia(c, i, 'question', 'Question', "Ex : Capitale de l'Espagne")}
                    ${htmlChampMedia(c, i, 'reponse', 'Réponse', 'Ex : Madrid')}
                    ${htmlChampMedia(c, i, 'exemple', 'Phrase d\'exemple (facultatif)', 'Ex : Madrid es la capital de España.')}
                    ${htmlChampMedia(c, i, 'indice', '💡 Indice (facultatif)', 'Ex : commence par M...')}
                </div>
                <button class="icon-btn danger" data-suppr-carte="${i}">🗑</button>
            </div>
        `).join('');

        // Textes
        conteneur.querySelectorAll('.input-champ-texte').forEach(inp => inp.addEventListener('input', () => {
            supportActif.cartes[parseInt(inp.dataset.idx, 10)][inp.dataset.champ] = inp.value;
            sauvegarderSupportsDifferee();
        }));
        // Images par champ
        conteneur.querySelectorAll('.input-image-champ').forEach(inp => inp.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const idx = parseInt(inp.dataset.idx, 10);
            const champ = inp.dataset.champ;
            compresserImageFichier(file, 600, 0.82, dataUrl => {
                supportActif.cartes[idx][champ + 'Image'] = dataUrl;
                sauvegarderSupports();
                chargerEditionTexte();
            });
        }));
        // Suppression carte
        conteneur.querySelectorAll('[data-suppr-carte]').forEach(btn => btn.addEventListener('click', () => {
            supportActif.cartes.splice(parseInt(btn.dataset.supprCarte, 10), 1);
            sauvegarderSupports();
            chargerEditionTexte();
        }));
    }
    definirTexte('compteurCartesTexte', supportActif.cartes.length + ' carte' + (supportActif.cartes.length === 1 ? '' : 's'));
    const btnRevFlash = document.getElementById('btnReviserFlash');
    if (btnRevFlash) btnRevFlash.style.display = supportActif.cartes.length > 0 ? '' : 'none';
}

function supprimerImageChamp(idx, champ) {
    delete supportActif.cartes[idx][champ + 'Image'];
    sauvegarderSupports();
    chargerEditionTexte();
}

function remplirSelecteurVoix() {
    const select = document.getElementById('champVoixSupport');
    const langue = (supportActif.langue === 'la' ? 'fr-FR' : (supportActif.langue || 'fr-FR'));
    const prefixe = langue.split('-')[0];
    if (!voixDisponibles.length) chargerVoixDisponibles();
    const correspondantes = voixDisponibles.filter(v => v.lang.split('-')[0] === prefixe);
    select.innerHTML = '<option value="">— Choix automatique —</option>'
        + correspondantes.map(v => `<option value="${echapperHtml(v.name)}">${echapperHtml(v.name)}${v.localService ? '' : ' (en ligne)'}</option>`).join('');
    select.value = supportActif.voixNom && correspondantes.some(v => v.name === supportActif.voixNom) ? supportActif.voixNom : '';
    // Les voix mettent parfois un instant à se charger sur Safari : on retente une fois après un court délai.
    if (correspondantes.length === 0) {
        setTimeout(() => {
            if (document.getElementById('vueEditionTexte').style.display !== 'none') remplirSelecteurVoix();
        }, 400);
    }
}

function changerVoixSupport(valeur) {
    if (!supportActif) return;
    supportActif.voixNom = valeur || '';
    sauvegarderSupports();
}

function testerVoixSupport() {
    const texte = (supportActif.cartes[0] && supportActif.cartes[0].question) || 'Ceci est un test de la voix sélectionnée.';
    lireTexte(texte, supportActif.langue, supportActif.voixNom);
}

function changerLangueSupport(valeur) {
    if (!supportActif) return;
    supportActif.langue = valeur;
    supportActif.voixNom = ''; // la voix précise dépend de la langue, on réinitialise au changement
    sauvegarderSupports();
    remplirSelecteurVoix();
}

function changerStyleRevelation(valeur) {
    if (!supportActif) return;
    supportActif.styleRevelation = valeur;
    sauvegarderSupports();
}

function ajouterCarteTexte() {
    supportActif.cartes.push({ question: '', reponse: '', exemple: '' });
    sauvegarderSupports();
    chargerEditionTexte();
    setTimeout(() => {
        const inputs = document.querySelectorAll('.input-question');
        if (inputs.length) inputs[inputs.length - 1].focus();
    }, 50);
}

/* ---------------- Mode Texte : révision (Leitner) ---------------- */

let etatRevisionTexte = null;
let modeSessionMelangee = false;

function initEtatRevisionTexte() {
    etatRevisionTexte = supportActif.etat || (supportActif.etat = {});
    supportActif.cartes.forEach((c, i) => {
        if (!etatRevisionTexte[i]) etatRevisionTexte[i] = { box: 1, nextDue: todayStr(), indicePerso: '', autoExplication: '' };
        if (etatRevisionTexte[i].indicePerso === undefined) etatRevisionTexte[i].indicePerso = '';
        if (etatRevisionTexte[i].autoExplication === undefined) etatRevisionTexte[i].autoExplication = '';
    });
    sauvegarderSupports();
}

function estDueTexte(i) { return etatRevisionTexte[i].nextDue <= todayStr(); }

function getSupportParId(id) { return supports.find(s => s.id === id); }
function getEtatCarte(carteEl) {
    const s = getSupportParId(carteEl.dataset.supportId);
    return s.etat[carteEl.dataset.idx];
}
function getDonneesCarte(carteEl) {
    const s = getSupportParId(carteEl.dataset.supportId);
    return s.cartes[carteEl.dataset.idx];
}

let voixDisponibles = [];
function chargerVoixDisponibles() { voixDisponibles = window.speechSynthesis ? window.speechSynthesis.getVoices() : []; }
if ('speechSynthesis' in window) {
    chargerVoixDisponibles();
    window.speechSynthesis.onvoiceschanged = chargerVoixDisponibles;
}

function lireTexte(texte, langue, voixNom) {
    if (!texte) return;
    if (!('speechSynthesis' in window)) { alert("La lecture audio n'est pas disponible sur cet appareil."); return; }
    window.speechSynthesis.cancel();
    const langueEffective = (langue === 'la') ? 'fr-FR' : (langue || 'fr-FR');
    const utter = new SpeechSynthesisUtterance(texte);
    utter.lang = langueEffective;
    if (!voixDisponibles.length) chargerVoixDisponibles();
    let voix = voixNom ? voixDisponibles.find(v => v.name === voixNom) : null;
    if (!voix) {
        const prefixe = langueEffective.split('-')[0];
        voix = voixDisponibles.find(v => v.lang === langueEffective) || voixDisponibles.find(v => v.lang.split('-')[0] === prefixe);
    }
    if (voix) utter.voice = voix;
    window.speechSynthesis.speak(utter);
}

function creerElementCarte(support, idx) {
    const c = support.cartes[idx];
    const etat = support.etat[idx];
    const langue = support.langue || 'fr-FR';
    const modeFlip = (support.styleRevelation || 'flou') === 'flip';

    const carte = document.createElement('div');
    carte.className = 'carte-revision-texte' + (modeFlip ? ' mode-flip' : '');
    carte.dataset.supportId = support.id;
    carte.dataset.idx = idx;

    const question = document.createElement('div');
    question.className = 'question-texte';
    const texteQuestion = document.createElement('span');
    texteQuestion.textContent = c.question;
    question.appendChild(texteQuestion);
    const btnAudioQ = document.createElement('button');
    btnAudioQ.className = 'btn-audio';
    btnAudioQ.textContent = '🔊';
    btnAudioQ.addEventListener('click', (ev) => { ev.stopPropagation(); lireTexte(c.question, langue, support.voixNom); });
    question.appendChild(btnAudioQ);
    if (modeSessionMelangee) {
        const etiquette = document.createElement('div');
        etiquette.className = 'etiquette-support-melange';
        etiquette.textContent = '📂 ' + support.nom;
        carte.appendChild(etiquette);
    }
    carte.appendChild(question);

    if (c.image) {
        const img = document.createElement('img');
        img.className = 'image-carte-revision';
        img.src = c.image;
        carte.appendChild(img);
    }

    const confianceBar = document.createElement('div');
    confianceBar.className = 'confiance-bar';
    [['sur', '🟢 Sûr'], ['incertain', '🟡 Incertain'], ['aucune', '🔴 Aucune idée']].forEach(([val, label]) => {
        const b = document.createElement('button');
        b.className = 'btn-confiance btn-confiance-' + val;
        b.textContent = label;
        b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            carte.dataset.confiance = val;
            toggleReveleTexte(carte);
        });
        confianceBar.appendChild(b);
    });
    carte.appendChild(confianceBar);

    // En mode simple, la barre de confiance est masquée : un tap direct sur la carte révèle la réponse.
    carte.addEventListener('click', (ev) => {
        if (document.body.classList.contains('mode-simple') && !carte.classList.contains('revele')) {
            if (!carte.dataset.confiance) carte.dataset.confiance = 'sur';
            toggleReveleTexte(carte);
        }
    });

    const reponseWrap = document.createElement('div');
    reponseWrap.className = 'reponse-wrap';

    // Contenu de la réponse (texte + exemple + audio), commun aux deux styles
    const contenuReponse = document.createElement('div');
    const reponse = document.createElement('div');
    reponse.className = 'reponse-texte';
    reponse.textContent = c.reponse;
    contenuReponse.appendChild(reponse);
    if (c.exemple) {
        const exemple = document.createElement('div');
        exemple.className = 'exemple-texte';
        exemple.textContent = '« ' + c.exemple + ' »';
        contenuReponse.appendChild(exemple);
    }
    const btnAudioR = document.createElement('button');
    btnAudioR.className = 'btn-audio btn-audio-reponse';
    btnAudioR.textContent = '🔊';
    btnAudioR.addEventListener('click', (ev) => { ev.stopPropagation(); lireTexte(c.reponse, langue, support.voixNom); });
    contenuReponse.appendChild(btnAudioR);

    if (modeFlip) {
        const inner = document.createElement('div');
        inner.className = 'reponse-inner';
        const faceAvant = document.createElement('div');
        faceAvant.className = 'face-carte face-avant';
        faceAvant.textContent = '🂠 Tape pour retourner';
        const faceArriere = document.createElement('div');
        faceArriere.className = 'face-carte face-arriere';
        faceArriere.appendChild(contenuReponse);
        inner.appendChild(faceAvant);
        inner.appendChild(faceArriere);
        reponseWrap.appendChild(inner);
    } else {
        reponseWrap.appendChild(contenuReponse);
    }

    const niveau = document.createElement('div');
    niveau.className = 'boite-niveau';
    reponseWrap.appendChild(niveau);

    const indiceBtn = document.createElement('div');
    indiceBtn.className = 'indice-btn';
    indiceBtn.textContent = '💡';
    indiceBtn.addEventListener('click', (ev) => { ev.stopPropagation(); carte.classList.toggle('indice-actif'); });
    reponseWrap.appendChild(indiceBtn);

    const panel = document.createElement('div');
    panel.className = 'indice-panel';
    panel.addEventListener('click', (ev) => ev.stopPropagation());
    const labelPerso = document.createElement('span');
    labelPerso.className = 'indice-perso-label';
    labelPerso.textContent = '✏️ Mon indice personnel';
    panel.appendChild(labelPerso);
    const inputPerso = document.createElement('input');
    inputPerso.type = 'text';
    inputPerso.className = 'indice-perso-input';
    inputPerso.placeholder = 'Ex : ça me fait penser à...';
    inputPerso.value = etat.indicePerso || '';
    inputPerso.addEventListener('input', () => { etat.indicePerso = inputPerso.value; sauvegarderSupportsDifferee(); });
    panel.appendChild(inputPerso);
    reponseWrap.appendChild(panel);

    carte.appendChild(reponseWrap);

    const declare = document.createElement('div');
    declare.className = 'declare-texte';
    const btnOk = document.createElement('button');
    btnOk.className = 'btn-ok';
    btnOk.textContent = '✓ Je savais';
    btnOk.addEventListener('click', (ev) => { ev.stopPropagation(); declarerTexte(carte, true); });
    const btnNon = document.createElement('button');
    btnNon.className = 'btn-non';
    btnNon.textContent = '✗ Je ne savais pas';
    btnNon.addEventListener('click', (ev) => { ev.stopPropagation(); declarerTexte(carte, false); });
    declare.appendChild(btnOk);
    declare.appendChild(btnNon);
    carte.appendChild(declare);

    const explicationWrap = document.createElement('div');
    explicationWrap.className = 'explication-wrap';
    const explicationLabel = document.createElement('span');
    explicationLabel.className = 'indice-perso-label';
    explicationLabel.textContent = '🤔 Comment je m\'en suis souvenu ?';
    explicationWrap.appendChild(explicationLabel);
    const inputExplication = document.createElement('input');
    inputExplication.type = 'text';
    inputExplication.className = 'indice-perso-input';
    inputExplication.placeholder = 'Ex : ça ressemble au mot français...';
    inputExplication.value = etat.autoExplication || '';
    inputExplication.addEventListener('click', (ev) => ev.stopPropagation());
    inputExplication.addEventListener('input', () => { etat.autoExplication = inputExplication.value; sauvegarderSupportsDifferee(); });
    explicationWrap.appendChild(inputExplication);
    carte.appendChild(explicationWrap);

    return carte;
}

function construireVueRevisionTexte() {
    document.getElementById('titreHeader').textContent = supportActif.nom;
    modeSessionMelangee = false;
    initEtatRevisionTexte();

    (document.getElementById('controlesSeulTexte') || {style:{}}).style.display = '';
    (document.getElementById('controlesExercicesTexte') || {style:{}}).style.display = '';
    (document.getElementById('segmenteTexte') || {style:{}}).style.display = '';

    const mode = supportActif.mode || 'simple';
    document.body.classList.toggle('mode-simple', mode === 'simple');
    document.querySelectorAll('#segmenteTexte .mode-btn').forEach(b => b.classList.toggle('actif', b.dataset.mode === mode));
    document.querySelector('#segmenteTexte .thumb').classList.toggle('pos-1', mode === 'complet');
    document.body.classList.remove('filtre-actif');
    document.getElementById('btnFiltreTexte').textContent = '📅 Cartes à réviser';

    const conteneur = document.getElementById('listeRevisionTexte');
    conteneur.innerHTML = '';
    const ordre = supportActif.cartes.map((c, i) => i);
    for (let i = ordre.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
    }
    ordre.forEach(i => conteneur.appendChild(creerElementCarte(supportActif, i)));

    actualiserAffichageRevisionTexte();
}

function ouvrirSessionMelangee() {
    const paires = [];
    supports.forEach(s => {
        if (s.type !== 'texte') return;
        const etat = s.etat || (s.etat = {});
        (s.cartes || []).forEach((c, i) => {
            if (!etat[i]) etat[i] = { box: 1, nextDue: todayStr(), indicePerso: '', autoExplication: '' };
            if (etat[i].nextDue <= todayStr()) paires.push({ support: s, idx: i });
        });
    });
    if (paires.length === 0) {
        alert("Aucune carte à réviser aujourd'hui parmi tes Flashcards. Reviens plus tard, ou ouvre un support en particulier pour réviser par anticipation.");
        return;
    }
    // Les plus en retard (date d'échéance la plus ancienne) passent en priorité.
    paires.sort((a, b) => a.support.etat[a.idx].nextDue.localeCompare(b.support.etat[b.idx].nextDue));
    const nbReportees = Math.max(0, paires.length - PLAFOND_PAR_JOUR);
    const paireRetenues = paires.slice(0, PLAFOND_PAR_JOUR);
    // Mélange ensuite l'ordre de présentation (entrelacement), une fois la sélection des plus prioritaires faite.
    for (let i = paireRetenues.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [paireRetenues[i], paireRetenues[j]] = [paireRetenues[j], paireRetenues[i]];
    }
    sauvegarderSupports();

    supportActif = null;
    modeSessionMelangee = true;
    afficherVue('revisionCarte');
    document.getElementById('titreHeader').textContent = '🔀 Session mélangée';
    if (nbReportees > 0) {
        const note = document.createElement('div');
        note.style.cssText = 'font-size:13px;color:var(--gris-texte);text-align:center;margin-bottom:10px;';
        note.textContent = '📦 ' + nbReportees + " carte(s) dues supplémentaires reportées à demain.";
        document.getElementById('vueRevisionCarte').prepend(note);
    }
    construireVueRevisionCarte(paireRetenues);
}

function toggleReveleTexte(carte) { carte.classList.toggle('revele'); }

function declarerTexte(carteEl, bon) {
    carteEl.classList.remove('correcte', 'incorrecte');
    carteEl.classList.add(bon ? 'correcte' : 'incorrecte');
    const etat = getEtatCarte(carteEl);
    const support = getSupportParId(carteEl.dataset.supportId);
    const confiance = carteEl.dataset.confiance || 'sur';

    majEchecsConsecutifs(etat, bon);

    if ((support.mode || 'simple') === 'complet') {
        appliquerSM2(etat, qualiteSM2(bon, confiance));
    } else {
        if (!bon) {
            etat.box = 1;
        } else if (confiance === 'aucune') {
            etat.box = 1; // bonne réponse mais sans certitude : pas de progression, ça ressemble à de la chance
        } else if (confiance === 'incertain') {
            etat.box = Math.min(3, etat.box + 1); // progression plafonnée, retest plus rapproché
        } else {
            etat.box = Math.min(5, etat.box + 1);
        }
        etat.nextDue = addDays(todayStr(), INTERVALLES[etat.box - 1]);
    }

    sauvegarderSupports();
    afficherToastTexte(bon);
    actualiserAffichageRevisionTexte();
}

function afficherToastTexte(bon) {
    const bonnes = document.querySelectorAll('#listeRevisionTexte .carte-revision-texte.correcte').length;
    const mauvaises = document.querySelectorAll('#listeRevisionTexte .carte-revision-texte.incorrecte').length;
    const total = document.querySelectorAll('#listeRevisionTexte .carte-revision-texte').length;
    const toast = document.getElementById('toast');
    document.getElementById('toastMsg').textContent = bon ? '✅ Bonne réponse !' : '❌ À revoir !';
    document.getElementById('toastScore').textContent = bonnes + ' ✅  /  ' + mauvaises + ' ❌  (sur ' + total + ')';
    toast.classList.remove('bonne', 'mauvaise');
    toast.classList.add(bon ? 'bonne' : 'mauvaise');
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
}

function actualiserAffichageRevisionTexte() {
    document.querySelectorAll('#listeRevisionTexte .carte-revision-texte').forEach(c => {
        const e = getEtatCarte(c);
        const support = getSupportParId(c.dataset.supportId);
        const niveau = c.querySelector('.boite-niveau');
        const enComplet = (support.mode || 'simple') === 'complet';
        niveau.textContent = (enComplet && e.intervalle !== undefined) ? e.intervalle + 'j' : e.box;
        niveau.title = enComplet ? 'Intervalle actuel : ' + (e.intervalle || 1) + ' jour(s) · facilité ' + (e.easeFactor ? e.easeFactor.toFixed(2) : '2.50') : 'Boîte ' + e.box;
        niveau.className = 'boite-niveau niveau-' + e.box;
        c.classList.toggle('due', e.nextDue <= todayStr());
        c.classList.toggle('difficile', !!e.difficile);
    });
    majCompteurRevisionTexte();
    actualiserResumeBoitesTexte();
}

function majCompteurRevisionTexte() {
    const total = document.querySelectorAll('#listeRevisionTexte .carte-revision-texte').length;
    const bonnes = document.querySelectorAll('#listeRevisionTexte .carte-revision-texte.correcte').length;
    const mauvaises = document.querySelectorAll('#listeRevisionTexte .carte-revision-texte.incorrecte').length;
    ((document.getElementById('compteurRevisionTexte') || {})).textContent = '✅ ' + bonnes + '   ❌ ' + mauvaises + '   (sur ' + total + ' cartes, cette session)';
}

function actualiserResumeBoitesTexte() {
    const counts = [0, 0, 0, 0, 0], duesParBoite = [0, 0, 0, 0, 0];
    let total = 0, duesTotal = 0;
    document.querySelectorAll('#listeRevisionTexte .carte-revision-texte').forEach(c => {
        const e = getEtatCarte(c);
        counts[e.box - 1]++;
        total++;
        if (e.nextDue <= todayStr()) { duesParBoite[e.box - 1]++; duesTotal++; }
    });
    document.getElementById('resumeBoitesTexte').innerHTML = htmlStatsVisuelles(counts, total, duesTotal, 'carte(s)');
}

function remasquerToutRevisionTexte() {
    document.querySelectorAll('#listeRevisionTexte .carte-revision-texte').forEach(c => c.classList.remove('revele', 'correcte', 'incorrecte'));
    majCompteurRevisionTexte();
}

function basculerFiltreTexte() {
    document.body.classList.toggle('filtre-actif');
    const actif = document.body.classList.contains('filtre-actif');
    document.getElementById('btnFiltreTexte').textContent = actif ? '👀 Tout afficher' : '📅 Cartes à réviser';
}

function reinitialiserProgressionTexte() {
    if (modeSessionMelangee) { alert("Ouvre un support en particulier pour réinitialiser sa progression."); return; }
    if (!confirm('Effacer toute ta progression sur ce support (y compris tes indices personnels) ? Cette action est irréversible.')) return;
    supportActif.etat = {};
    supportActif.cartes.forEach((c, i) => { supportActif.etat[i] = { box: 1, nextDue: todayStr(), indicePerso: '', autoExplication: '' }; });
    etatRevisionTexte = supportActif.etat;
    sauvegarderSupports();
    document.querySelectorAll('#listeRevisionTexte .carte-revision-texte').forEach(c => {
        c.classList.remove('revele', 'correcte', 'incorrecte', 'indice-actif');
        c.querySelectorAll('.indice-perso-input').forEach(inp => inp.value = '');
    });
    actualiserAffichageRevisionTexte();
}

function changerModeTexte(mode) {
    if (modeSessionMelangee) return;
    supportActif.mode = mode;
    document.body.classList.toggle('mode-simple', mode === 'simple');
    document.querySelectorAll('#segmenteTexte .mode-btn').forEach(b => b.classList.toggle('actif', b.dataset.mode === mode));
    document.querySelector('#segmenteTexte .thumb').classList.toggle('pos-1', mode === 'complet');
    if (mode === 'simple') {
        document.body.classList.remove('filtre-actif');
        document.getElementById('btnFiltreTexte').textContent = '📅 Cartes à réviser';
    }
    sauvegarderSupports();
}

/* ---------------- Mode QCM ---------------- */

let qcmEtat = { cartes: [], index: 0, score: 0 };

function lancerQCM() {
    if (!supportActif || supportActif.cartes.length < 4) {
        alert("Il faut au moins 4 cartes dans ce paquet pour lancer un QCM (il en faut assez pour proposer de mauvaises réponses).");
        return;
    }
    const ordre = supportActif.cartes.map((c, i) => i);
    for (let i = ordre.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
    }
    qcmEtat = { cartes: ordre, index: 0, score: 0 };
    afficherVue('qcmTexte');
    afficherQuestionQCM();
}

function afficherQuestionQCM() {
    document.getElementById('feedbackQCM').textContent = '';
    document.getElementById('btnSuivantQCM').style.display = 'none';
    const idx = qcmEtat.cartes[qcmEtat.index];
    const c = supportActif.cartes[idx];
    document.getElementById('progressionQCM').textContent = 'Question ' + (qcmEtat.index + 1) + ' / ' + qcmEtat.cartes.length + '   ·   Score : ' + qcmEtat.score;
    document.getElementById('questionQCM').textContent = c.question;
    document.getElementById('imageQCM').innerHTML = c.image ? '<img src="' + c.image + '" class="image-carte-revision">' : '';

    const autresReponses = supportActif.cartes.filter((cc, ii) => ii !== idx && cc.reponse).map(cc => cc.reponse);
    const dispo = autresReponses.slice();
    const leurres = [];
    while (leurres.length < 3 && dispo.length > 0) {
        const r = Math.floor(Math.random() * dispo.length);
        leurres.push(dispo.splice(r, 1)[0]);
    }
    const choix = [c.reponse].concat(leurres);
    for (let i = choix.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [choix[i], choix[j]] = [choix[j], choix[i]];
    }

    const conteneur = document.getElementById('choixQCM');
    conteneur.innerHTML = '';
    choix.forEach(rep => {
        const btn = document.createElement('button');
        btn.className = 'choix-qcm';
        btn.textContent = rep;
        btn.addEventListener('click', () => repondreQCM(btn, rep === c.reponse, idx));
        conteneur.appendChild(btn);
    });
}

function repondreQCM(btnClique, bon, idx) {
    document.querySelectorAll('#choixQCM button').forEach(b => b.disabled = true);
    const c = supportActif.cartes[idx];
    document.querySelectorAll('#choixQCM button').forEach(b => {
        if (b.textContent === c.reponse) b.classList.add('choix-correct');
    });
    if (!bon) btnClique.classList.add('choix-incorrect');
    if (bon) qcmEtat.score++;
    document.getElementById('feedbackQCM').textContent = bon ? '✅ Bonne réponse !' : '❌ La bonne réponse était : ' + c.reponse;
    document.getElementById('btnSuivantQCM').style.display = '';
}

function questionSuivanteQCM() {
    qcmEtat.index++;
    if (qcmEtat.index >= qcmEtat.cartes.length) {
        document.getElementById('questionQCM').textContent = '🏁 Terminé !';
        document.getElementById('imageQCM').innerHTML = '';
        document.getElementById('choixQCM').innerHTML = '';
        document.getElementById('feedbackQCM').textContent = '';
        document.getElementById('progressionQCM').textContent = 'Score final : ' + qcmEtat.score + ' / ' + qcmEtat.cartes.length;
        document.getElementById('btnSuivantQCM').style.display = 'none';
        return;
    }
    afficherQuestionQCM();
}

/* ---------------- Mode Écrire (saisie + correction tolérante) ---------------- */

let ecrireEtat = { cartes: [], index: 0, score: 0 };

function lancerEcrire() {
    if (!supportActif || supportActif.cartes.length === 0) { alert('Ajoute au moins une carte avant de lancer cet exercice.'); return; }
    const ordre = supportActif.cartes.map((c, i) => i);
    for (let i = ordre.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
    }
    ecrireEtat = { cartes: ordre, index: 0, score: 0 };
    afficherVue('ecrireTexte');
    afficherQuestionEcrire();
}

function afficherQuestionEcrire() {
    document.getElementById('feedbackEcrire').textContent = '';
    document.getElementById('btnSuivantEcrire').style.display = 'none';
    document.getElementById('champReponseEcrire').style.display = '';
    document.getElementById('btnValiderEcrire').style.display = '';
    const champ = document.getElementById('champReponseEcrire');
    champ.value = '';
    champ.disabled = false;
    const idx = ecrireEtat.cartes[ecrireEtat.index];
    const c = supportActif.cartes[idx];
    document.getElementById('progressionEcrire').textContent = 'Question ' + (ecrireEtat.index + 1) + ' / ' + ecrireEtat.cartes.length + '   ·   Score : ' + ecrireEtat.score;
    document.getElementById('questionEcrire').textContent = c.question;
    document.getElementById('imageEcrire').innerHTML = c.image ? '<img src="' + c.image + '" class="image-carte-revision">' : '';
    champ.focus();
}

function normaliserTexteComparaison(s) {
    return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ');
}

function distanceLevenshtein(a, b) {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
        }
    }
    return d[m][n];
}

function validerEcrire() {
    const champ = document.getElementById('champReponseEcrire');
    if (champ.disabled) return;
    champ.disabled = true;
    const idx = ecrireEtat.cartes[ecrireEtat.index];
    const c = supportActif.cartes[idx];
    const saisie = normaliserTexteComparaison(champ.value);
    const attendue = normaliserTexteComparaison(c.reponse);
    const dist = distanceLevenshtein(saisie, attendue);
    const seuil = attendue.length <= 4 ? 0 : (attendue.length <= 8 ? 1 : 2);

    if (saisie === attendue) {
        ecrireEtat.score++;
        document.getElementById('feedbackEcrire').textContent = '✅ Exact !';
    } else if (dist <= seuil) {
        ecrireEtat.score++;
        document.getElementById('feedbackEcrire').textContent = '🟡 Presque ! Réponse attendue : ' + c.reponse + ' (petite faute tolérée, comptée bonne)';
    } else {
        document.getElementById('feedbackEcrire').textContent = '❌ Réponse attendue : ' + c.reponse;
    }
    document.getElementById('btnSuivantEcrire').style.display = '';
}

function questionSuivanteEcrire() {
    ecrireEtat.index++;
    if (ecrireEtat.index >= ecrireEtat.cartes.length) {
        document.getElementById('questionEcrire').textContent = '🏁 Terminé !';
        document.getElementById('imageEcrire').innerHTML = '';
        document.getElementById('champReponseEcrire').style.display = 'none';
        document.getElementById('btnValiderEcrire').style.display = 'none';
        document.getElementById('feedbackEcrire').textContent = '';
        document.getElementById('progressionEcrire').textContent = 'Score final : ' + ecrireEtat.score + ' / ' + ecrireEtat.cartes.length;
        document.getElementById('btnSuivantEcrire').style.display = 'none';
        return;
    }
    afficherQuestionEcrire();
}

function quitterExerciceTexte() {
    afficherVue('revisionTexte');
    construireVueRevisionTexte();
}

/* ---------------- Export PDF du paquet ---------------- */

function exporterPDF() {
    if (!supportActif || supportActif.cartes.length === 0) { alert("Ajoute des cartes avant d'exporter."); return; }
    const zone = document.getElementById('zoneImpressionTexte');
    zone.innerHTML = '<h1 style="text-align:center;">' + echapperHtml(supportActif.nom) + '</h1>'
        + supportActif.cartes.map((c, i) => `
            <div class="ligne-impression">
                <div class="case-impression"><strong>${i + 1}. ${echapperHtml(c.question)}</strong>${c.image ? '<br><img src="' + c.image + '">' : ''}</div>
                <div class="case-impression">${echapperHtml(c.reponse)}${c.exemple ? '<br><em>' + echapperHtml(c.exemple) + '</em>' : ''}</div>
            </div>
        `).join('');
    document.body.classList.add('impression-active');
    window.print();
    setTimeout(() => document.body.classList.remove('impression-active'), 500);
}

/* ================================================================
   MODULES : gélules d'activation/désactivation
   ================================================================ */

const CLE_MODULES = 'modulesActifs';
let modulesActifs = { algo: false, agenda: false };

async function chargerModules() {
    try {
        const db = await ouvrirDB();
        const donnees = await new Promise((resolve, reject) => {
            const tx = db.transaction(MAGASIN, 'readonly');
            const req = tx.objectStore(MAGASIN).get(CLE_MODULES);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        // Migration : si ancien format avec 'algo', convertir en 'stats'
        const base = { stats: false, agenda: false };
        const sauvegarde = donnees || {};
        if ('algo' in sauvegarde && !('stats' in sauvegarde)) {
            sauvegarde.stats = sauvegarde.algo;
        }
        return Object.assign(base, sauvegarde);
    } catch (e) {
        try {
            const r = localStorage.getItem('memo_modules_v1');
            const sauvegarde = r ? JSON.parse(r) : {};
            if ('algo' in sauvegarde && !('stats' in sauvegarde)) sauvegarde.stats = sauvegarde.algo;
            return Object.assign({ stats: false, agenda: false }, sauvegarde);
        } catch (e2) { return { stats: false, agenda: false }; }
    }
}

async function sauvegarderModules() {
    try {
        const db = await ouvrirDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(MAGASIN, 'readwrite');
            tx.objectStore(MAGASIN).put(modulesActifs, CLE_MODULES);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        try { localStorage.setItem('memo_modules_v1', JSON.stringify(modulesActifs)); } catch (e2) { /* tant pis */ }
    }
}

function appliquerModules() {
    // Plus de modules configurables — stats toujours visibles, agenda toujours actif
}

async function basculerModule(nom) {
    if (nom === 'agenda') return; // L'agenda est toujours actif
    modulesActifs[nom] = !modulesActifs[nom];
    await sauvegarderModules();
    appliquerModules();
}

/* ================================================================
   AGENDA : calendrier semaine/mois + objectifs d'évaluation
   ================================================================ */

const CLE_OBJECTIFS = 'objectifsRevision';
let objectifs = [];
let agendaVue = 'semaine'; // 'semaine' | 'mois'
let agendaDateRef = new Date(); // date de référence pour navigation
agendaDateRef.setHours(0, 0, 0, 0);
let agendaJourSelectionne = null;

async function chargerObjectifs() {
    try {
        const db = await ouvrirDB();
        const donnees = await new Promise((resolve, reject) => {
            const tx = db.transaction(MAGASIN, 'readonly');
            const req = tx.objectStore(MAGASIN).get(CLE_OBJECTIFS);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return Array.isArray(donnees) ? donnees : [];
    } catch (e) {
        try { const r = localStorage.getItem('memo_objectifs_v1'); return r ? JSON.parse(r) : []; }
        catch (e2) { return []; }
    }
}

async function sauvegarderObjectifs() {
    try {
        const db = await ouvrirDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(MAGASIN, 'readwrite');
            tx.objectStore(MAGASIN).put(objectifs, CLE_OBJECTIFS);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        try { localStorage.setItem('memo_objectifs_v1', JSON.stringify(objectifs)); } catch (e2) { /* tant pis */ }
    }
}

/* -- Navigation -- */
function agendaNaviguer(delta) {
    if (agendaVue === 'semaine') {
        agendaDateRef = new Date(agendaDateRef.getTime() + delta * 7 * 86400000);
    } else {
        agendaDateRef = new Date(agendaDateRef.getFullYear(), agendaDateRef.getMonth() + delta, 1);
    }
    agendaJourSelectionne = null;
    rendreAgenda();
}

function changerVueAgenda(vue) {
    agendaVue = vue;
    agendaJourSelectionne = null;
    rendreAgenda();
}

/* -- Calcul des données par jour -- */
function dateStr(d) { return localeDateStr(d); }

function calculerChargeParsupport() {
    const charge = {}; // { 'YYYY-MM-DD': { revisions: n, objectifs: [{titre,couleur}] } }
    const today = dateStr(new Date());

    // Révisions dues par jour (calcul prospectif sur 60 jours)
    supports.forEach(s => {
        const iterer = (cle, nextDue) => {
            if (!nextDue) return;
            const j = nextDue <= today ? today : nextDue;
            if (!charge[j]) charge[j] = { revisions: 0, objectifs: [] };
            charge[j].revisions++;
        };
        if (s.type === 'texte') {
            (s.cartes || []).forEach((c, i) => { const e = s.etat && s.etat[i]; if (e) iterer(i, e.nextDue); });
        } else {
            (s.pages || []).forEach((page, pi) => {
                page.zones.forEach((z, zi) => { const e = s.etat && s.etat[pi + '_' + zi]; if (e) iterer(pi + '_' + zi, e.nextDue); });
            });
        }
    });

    // Objectifs d'évaluation
    objectifs.forEach(obj => {
        if (!obj.dateEval) return;
        if (!charge[obj.dateEval]) charge[obj.dateEval] = { revisions: 0, objectifs: [] };
        charge[obj.dateEval].objectifs.push({ titre: obj.titre, type: 'evaluation' });
        (obj.joursPlanning || []).forEach(j => {
            if (!charge[j]) charge[j] = { revisions: 0, objectifs: [] };
            charge[j].objectifs.push({ titre: obj.titre, type: 'planifie' });
        });
    });

    return charge;
}

/* -- Données agenda : étiquettes libres (persistées) -- */
const CLE_ETIQUETTES_AGENDA = 'etiquettesAgenda';
let etiquettesAgenda = {}; // { 'YYYY-MM-DD': [{ id, matiere, texte, puce, faite }] }

async function chargerEtiquettesAgenda() {
    try {
        const db = await ouvrirDB();
        const d = await new Promise((res, rej) => {
            const tx = db.transaction(MAGASIN, 'readonly');
            const req = tx.objectStore(MAGASIN).get(CLE_ETIQUETTES_AGENDA);
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
        });
        return d || {};
    } catch (e) {
        try { const r = localStorage.getItem('memo_agenda_etiq_v1'); return r ? JSON.parse(r) : {}; }
        catch (e2) { return {}; }
    }
}

async function sauvegarderEtiquettesAgenda() {
    try {
        const db = await ouvrirDB();
        await new Promise((res, rej) => {
            const tx = db.transaction(MAGASIN, 'readwrite');
            tx.objectStore(MAGASIN).put(etiquettesAgenda, CLE_ETIQUETTES_AGENDA);
            tx.oncomplete = res;
            tx.onerror = () => rej(tx.error);
        });
    } catch (e) {
        try { localStorage.setItem('memo_agenda_etiq_v1', JSON.stringify(etiquettesAgenda)); } catch (e2) {}
    }
}

const COULEURS_MATIERES_AGENDA = {
    'Anglais':{ bg:'#d1eaff', txt:'#0055aa', puce:'#007AFF' },
    'Histoire-Géo-EMC':{ bg:'#ffe4cc', txt:'#a04800', puce:'#FF9500' },
    'Maths':{ bg:'#e0d4ff', txt:'#5500cc', puce:'#9B59B6' },
    'SVT':{ bg:'#d4f5dd', txt:'#1a6e30', puce:'#2ecc71' },
    'Espagnol':{ bg:'#ffd6d6', txt:'#cc0000', puce:'#FF3B30' },
    'Latin':{ bg:'#f5e8c8', txt:'#7a5500', puce:'#e67e22' },
    'Français':{ bg:'#ffeef5', txt:'#880044', puce:'#e91e63' },
    'Sciences physiques':{ bg:'#e8f0fe', txt:'#1a5276', puce:'#3498db' },
    'EMI':{ bg:'#e8f5e9', txt:'#1b5e20', puce:'#4caf50' },
    'Sciences':{ bg:'#e0f7fa', txt:'#006064', puce:'#00bcd4' },
    'Éducation musicale':{ bg:'#fce4ec', txt:'#880e4f', puce:'#e91e63' },
    'Arts plastiques':{ bg:'#fff3e0', txt:'#e65100', puce:'#ff9800' },
};

function couleurEtiquette(matiere) {
    return COULEURS_MATIERES_AGENDA[matiere] || { bg:'#e8e8e8', txt:'#555', puce:'#888' };
}

/* -- Injection auto depuis les objectifs d'évaluation -- */
function calculerEtiquettesAuto() {
    const auto = {};
    const today = dateStr(new Date());
    // Révisions dues (par matière)
    supports.forEach(s => {
        const iterer = (nextDue) => {
            if (!nextDue) return;
            const j = nextDue <= today ? today : nextDue;
            if (!auto[j]) auto[j] = [];
            const existant = auto[j].find(e => e.matiere === s.matiere && e.texte.startsWith('Révision'));
            if (!existant) auto[j].push({ auto: true, matiere: s.matiere, texte: 'Révision', puce: couleurEtiquette(s.matiere).puce });
        };
        if (s.type === 'texte') {
            (s.cartes || []).forEach((c, i) => { const e = s.etat && s.etat[i]; if (e) iterer(e.nextDue); });
        } else {
            (s.pages || []).forEach((page, pi) => {
                page.zones.forEach((z, zi) => { const e = s.etat && s.etat[pi + '_' + zi]; if (e) iterer(e.nextDue); });
            });
        }
    });
    // Objectifs d'évaluation → étiquettes auto
    objectifs.forEach(obj => {
        if (obj.dateEval) {
            if (!auto[obj.dateEval]) auto[obj.dateEval] = [];
            auto[obj.dateEval].push({ auto: true, matiere: 'Éval', texte: '🎯 ' + obj.titre, puce: '#FF3B30' });
        }
        (obj.joursPlanning || []).forEach(j => {
            if (!auto[j]) auto[j] = [];
            auto[j].push({ auto: true, matiere: obj.titre.split(' ')[0], texte: '📚 ' + obj.titre, puce: '#FF9500' });
        });
    });
    return auto;
}

let agendaEditionEtat = { ds: null, idx: null, ajout: false };

function rendreAgenda() {
    const grille = document.getElementById('agendaGrille');
    const joursLabels = document.getElementById('agendaJoursLabels');
    const titrePeriode = document.getElementById('agendaTitrePeriode');
    if (!grille) return;

    const JOURS = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
    const MOIS_NOMS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];
    const today = dateStr(new Date());
    const etiqAuto = calculerEtiquettesAuto();

    // Pills de vue
    document.getElementById('pillSemaine').classList.toggle('actif', agendaVue === 'semaine');
    document.getElementById('pillMois').classList.toggle('actif', agendaVue === 'mois');

    let jours = [];
    if (agendaVue === 'semaine') {
        const lundi = new Date(agendaDateRef);
        const js = lundi.getDay() === 0 ? 6 : lundi.getDay() - 1;
        lundi.setDate(lundi.getDate() - js);
        titrePeriode.textContent = 'Semaine du ' + lundi.getDate() + ' ' + MOIS_NOMS[lundi.getMonth()];
        for (let i = 0; i < 7; i++) {
            const d = new Date(lundi); d.setDate(lundi.getDate() + i);
            jours.push({ date: d, hors: false });
        }
    } else {
        const annee = agendaDateRef.getFullYear(), mois = agendaDateRef.getMonth();
        titrePeriode.textContent = MOIS_NOMS[mois] + ' ' + annee;
        const premier = new Date(annee, mois, 1);
        const js = premier.getDay() === 0 ? 6 : premier.getDay() - 1;
        premier.setDate(premier.getDate() - js);
        for (let i = 0; i < 42; i++) {
            const d = new Date(premier); d.setDate(premier.getDate() + i);
            jours.push({ date: d, hors: d.getMonth() !== mois });
        }
    }

    joursLabels.innerHTML = JOURS.map(j => `<div class="agenda-jour-label">${j}</div>`).join('');
    grille.innerHTML = '';

    jours.forEach(({ date, hors }) => {
        const ds = dateStr(date);
        const estAjd = ds === today;
        const estSel = agendaJourSelectionne === ds;
        const cell = document.createElement('div');
        cell.className = 'agenda-jour-cell' + (estAjd ? ' aujourd-hui' : '') + (hors ? ' hors-mois' : '') + (estSel ? ' selectionne' : '');
        const numDiv = document.createElement('div');
        numDiv.className = 'agenda-num-jour' + (estAjd ? ' ajd' : '');
        numDiv.textContent = date.getDate();
        cell.appendChild(numDiv);

        // Étiquettes auto (issues du calcul)
        const autoJour = etiqAuto[ds] || [];
        autoJour.forEach(e => {
            const div = creerEtiqDOM(e, null);
            cell.appendChild(div);
        });

        // Étiquettes manuelles (stockées)
        const manuelles = etiquettesAgenda[ds] || [];
        manuelles.forEach((e, i) => {
            const div = creerEtiqDOM(e, i, ds);
            cell.appendChild(div);
        });

        cell.addEventListener('click', () => {
            agendaJourSelectionne = ds;
            agendaEditionEtat = { ds, idx: null, ajout: false };
            rendreAgenda();
            afficherDetailJour(ds);
        });
        grille.appendChild(cell);
    });

    if (agendaJourSelectionne) afficherDetailJour(agendaJourSelectionne);
    rendreObjectifs();
}

function creerEtiqDOM(e, idx, ds) {
    const couleur = e.puce ? e.puce : couleurEtiquette(e.matiere).puce;
    const bgBadge = couleurEtiquette(e.matiere).bg;
    const txtBadge = couleurEtiquette(e.matiere).txt;
    const div = document.createElement('div');
    div.className = 'agenda-etiq' + (e.faite ? ' faite' : '');
    div.innerHTML = `<div class="agenda-etiq-puce" style="background:${couleur}"></div>
        <span class="agenda-etiq-badge" style="background:${bgBadge};color:${txtBadge};">${e.matiere || ''}</span>
        <span class="agenda-etiq-txt">${echapperHtml(e.texte)}</span>`;
    if (idx !== null && ds) {
        div.style.cursor = 'pointer';
        div.addEventListener('click', (ev) => {
            ev.stopPropagation();
            agendaJourSelectionne = ds;
            agendaEditionEtat = { ds, idx, ajout: false };
            rendreAgenda();
            afficherDetailJour(ds);
        });
    }
    return div;
}

let agendaDetailJourActuel = null;

function afficherDetailJour(ds) {
    const panel = document.getElementById('agendaDetailPanel');
    const dateEl = document.getElementById('agendaDetailDate');
    const contenu = document.getElementById('agendaDetailContenu');
    if (!panel) return;
    agendaDetailJourActuel = ds;

    const dateObj = new Date(ds + 'T00:00:00');
    const MOIS = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
    dateEl.textContent = dateObj.getDate() + ' ' + MOIS[dateObj.getMonth()] + ' ' + dateObj.getFullYear();

    const manuelles = etiquettesAgenda[ds] || [];
    const autoJ = calculerEtiquettesAuto()[ds] || [];
    const toutes = [...autoJ.map(e => ({ ...e, manuel: false })), ...manuelles.map((e, i) => ({ ...e, manuel: true, idx: i }))];

    contenu.innerHTML = '';
    if (toutes.length === 0) {
        contenu.innerHTML = '<div style="font-size:13px;color:var(--gris-texte);padding:6px 0;">Aucune révision prévue ce jour.</div>';
    } else {
        toutes.forEach(e => {
            const couleur = e.puce || couleurEtiquette(e.matiere || '').puce;
            const bgBadge = couleurEtiquette(e.matiere || '').bg;
            const txtBadge = couleurEtiquette(e.matiere || '').txt;

            // Mode édition ?
            if (e.manuel && agendaEditionEtat.ds === ds && agendaEditionEtat.idx === e.idx && !agendaEditionEtat.ajout) {
                const wrap = document.createElement('div');
                wrap.className = 'agenda-edit-wrap';
                wrap.innerHTML = `<div style="font-size:10px;color:var(--gris-texte);margin-bottom:4px;">${e.matiere}</div>
                    <input type="text" id="agendaEditInput" value="${echapperHtml(e.texte)}" style="width:100%;border:none;background:transparent;font-size:13px;color:var(--texte);font-family:inherit;outline:none;">
                    <div class="agenda-edit-actions">
                        <button class="btn-ok-small" onclick="validerEditionEtiquette('${ds}',${e.idx})">OK</button>
                        <button class="btn-cancel-small" onclick="annulerEditionEtiquette()">Annuler</button>
                        <button class="btn-delete-small" onclick="supprimerEtiquette('${ds}',${e.idx})">Supprimer</button>
                    </div>`;
                contenu.appendChild(wrap);
                setTimeout(() => { const inp = document.getElementById('agendaEditInput'); if (inp) inp.focus(); }, 30);
                return;
            }

            const row = document.createElement('div');
            row.className = 'agenda-detail-item';
            const check = document.createElement('div');
            check.className = 'agenda-check' + (e.faite ? ' fait' : '');
            check.innerHTML = e.faite ? '✓' : '';
            if (e.manuel) {
                check.addEventListener('click', () => { cocherEtiquette(ds, e.idx); });
            }
            const badge = document.createElement('span');
            badge.className = 'agenda-detail-badge';
            badge.style.background = bgBadge;
            badge.style.color = txtBadge;
            badge.textContent = e.matiere || 'Auto';
            const txt = document.createElement('span');
            txt.className = 'agenda-detail-txt' + (e.faite ? ' faite' : '');
            txt.textContent = e.texte;
            row.appendChild(check);
            row.appendChild(badge);
            row.appendChild(txt);
            if (e.manuel) {
                const btnEdit = document.createElement('button');
                btnEdit.className = 'agenda-detail-edit';
                btnEdit.textContent = '✏️';
                btnEdit.addEventListener('click', () => {
                    agendaEditionEtat = { ds, idx: e.idx, ajout: false };
                    afficherDetailJour(ds);
                });
                row.appendChild(btnEdit);
            }
            contenu.appendChild(row);
        });
    }

    // Mode ajout ?
    if (agendaEditionEtat.ds === ds && agendaEditionEtat.ajout) {
        const wrap = document.createElement('div');
        wrap.className = 'agenda-edit-wrap';
        wrap.innerHTML = `<div style="font-size:10px;color:var(--gris-texte);margin-bottom:4px;">Nouvelle étiquette</div>
            <input type="text" id="agendaAjoutInput" placeholder="Ex : Histoire-Géo · J1" style="width:100%;border:none;background:transparent;font-size:13px;color:var(--texte);font-family:inherit;outline:none;">
            <div class="agenda-edit-actions">
                <button class="btn-ok-small" onclick="validerAjoutEtiquette('${ds}')">Ajouter</button>
                <button class="btn-cancel-small" onclick="annulerEditionEtiquette()">Annuler</button>
            </div>`;
        contenu.appendChild(wrap);
        setTimeout(() => { const inp = document.getElementById('agendaAjoutInput'); if (inp) inp.focus(); }, 30);
    }
    panel.style.display = '';
}

function ajouterEtiquetteJour() {
    if (!agendaDetailJourActuel) return;
    agendaEditionEtat = { ds: agendaDetailJourActuel, idx: null, ajout: true };
    afficherDetailJour(agendaDetailJourActuel);
}

async function validerAjoutEtiquette(ds) {
    const inp = document.getElementById('agendaAjoutInput');
    if (!inp || !inp.value.trim()) { annulerEditionEtiquette(); return; }
    if (!etiquettesAgenda[ds]) etiquettesAgenda[ds] = [];
    // Détection de la matière depuis le texte (pattern "Matière · ...")
    let matiere = 'Autre', texte = inp.value.trim();
    const parts = texte.split('·');
    if (parts.length >= 2) { matiere = parts[0].trim(); texte = parts.slice(1).join('·').trim(); }
    const couleur = couleurEtiquette(matiere);
    etiquettesAgenda[ds].push({ id: genererId(), matiere, texte: inp.value.trim(), puce: couleur.puce, faite: false });
    agendaEditionEtat = { ds, idx: null, ajout: false };
    await sauvegarderEtiquettesAgenda();
    rendreAgenda();
    afficherDetailJour(ds);
}

async function validerEditionEtiquette(ds, idx) {
    const inp = document.getElementById('agendaEditInput');
    if (!inp) return;
    if (etiquettesAgenda[ds] && etiquettesAgenda[ds][idx]) {
        etiquettesAgenda[ds][idx].texte = inp.value.trim();
    }
    agendaEditionEtat = { ds, idx: null, ajout: false };
    await sauvegarderEtiquettesAgenda();
    rendreAgenda();
    afficherDetailJour(ds);
}

async function supprimerEtiquette(ds, idx) {
    if (etiquettesAgenda[ds]) etiquettesAgenda[ds].splice(idx, 1);
    agendaEditionEtat = { ds, idx: null, ajout: false };
    await sauvegarderEtiquettesAgenda();
    rendreAgenda();
    afficherDetailJour(ds);
}

async function cocherEtiquette(ds, idx) {
    if (etiquettesAgenda[ds] && etiquettesAgenda[ds][idx]) {
        etiquettesAgenda[ds][idx].faite = !etiquettesAgenda[ds][idx].faite;
        await sauvegarderEtiquettesAgenda();
        rendreAgenda();
        afficherDetailJour(ds);
    }
}

function annulerEditionEtiquette() {
    agendaEditionEtat = { ds: agendaDetailJourActuel, idx: null, ajout: false };
    afficherDetailJour(agendaDetailJourActuel);
}

/* -- Objectifs d'évaluation -- */
function ouvrirModalObjectif() {
    document.getElementById('champTitreObjectif').value = '';
    document.getElementById('champMatiereObjectif').value = '';
    document.getElementById('champDateObjectif').value = '';
    document.getElementById('champJoursObjectif').value = '1, 3, 7, 14';
    document.getElementById('apercuJoursObjectif').textContent = '';
    const liste = document.getElementById('listeSupportsObjectif');
    liste.innerHTML = supports.length === 0
        ? '<div style="font-size:12px;color:var(--gris-texte);">Aucun support disponible.</div>'
        : supports.map(s => `
        <div class="case-support-objectif">
            <input type="checkbox" value="${s.id}" id="cb-${s.id}">
            <label for="cb-${s.id}" style="cursor:pointer;font-size:13px;">${ICONES_MATIERES[s.matiere] || '📦'} ${echapperHtml(s.nom)}</label>
        </div>
    `).join('');
    document.getElementById('modalObjectif').classList.add('ouverte');
}

function fermerModalObjectif() { document.getElementById('modalObjectif').classList.remove('ouverte'); }

function parseJours(valeur) {
    return valeur.split(',').map(v => parseInt(v.trim(), 10)).filter(n => !isNaN(n) && n > 0).sort((a, b) => b - a);
}

function majJoursPlanningSuggeres() {
    const dateEval = document.getElementById('champDateObjectif').value;
    const joursValeur = document.getElementById('champJoursObjectif').value;
    const apercuEl = document.getElementById('apercuJoursObjectif');
    if (!dateEval) { apercuEl.textContent = ''; return; }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const evalDate = new Date(dateEval + 'T00:00:00');
    const MOIS = ['jan','fév','mars','avr','mai','juin','juil','août','sep','oct','nov','déc'];
    const joursNbr = parseJours(joursValeur);
    const dates = joursNbr.map(n => {
        const d = new Date(evalDate);
        d.setDate(d.getDate() - n);
        return { n, d, valide: d > today };
    });
    if (!dates.length) { apercuEl.textContent = 'Aucun jour valide.'; return; }
    apercuEl.textContent = 'Révisions le : ' + dates.filter(x => x.valide).map(x => x.d.getDate() + ' ' + MOIS[x.d.getMonth()]).join(', ') + (dates.some(x => !x.valide) ? ' (certaines dates sont passées)' : '');
}

function calculerJoursPlanning(dateEval, joursNbr) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const evalDate = new Date(dateEval + 'T00:00:00');
    const jours = [];
    joursNbr.forEach(n => {
        const d = new Date(evalDate);
        d.setDate(d.getDate() - n);
        if (d > today) jours.push(dateStr(d));
    });
    return jours;
}

function validerObjectif() {
    const titre = document.getElementById('champTitreObjectif').value.trim();
    const dateEval = document.getElementById('champDateObjectif').value;
    if (!titre) { alert('Donne un titre à cet objectif.'); return; }
    if (!dateEval) { alert('Choisis une date d\'évaluation.'); return; }
    const matiere = document.getElementById('champMatiereObjectif').value;
    const joursNbr = parseJours(document.getElementById('champJoursObjectif').value);
    if (!joursNbr.length) { alert('Saisis au moins un nombre de jours (ex : 1, 3, 7).'); return; }
    const idsCoches = Array.from(document.querySelectorAll('#listeSupportsObjectif input:checked')).map(c => c.value);
    const joursPlanning = calculerJoursPlanning(dateEval, joursNbr);
    objectifs.push({
        id: genererId(),
        titre: titre,
        matiere: matiere,
        dateEval: dateEval,
        supportIds: idsCoches,
        joursNbr: joursNbr,
        joursPlanning: joursPlanning,
        creeLe: Date.now()
    });
    sauvegarderObjectifs();
    fermerModalObjectif();
    rendreAgenda();
}

function supprimerObjectif(id) {
    if (!confirm('Supprimer cet objectif ?')) return;
    objectifs = objectifs.filter(o => o.id !== id);
    sauvegarderObjectifs();
    rendreAgenda();
}

function rendreObjectifs() {
    const liste = document.getElementById('listeObjectifs');
    if (!liste) return;
    if (objectifs.length === 0) {
        liste.innerHTML = '<div style="font-size:13px; color:var(--gris-texte);">Aucune évaluation pour l\'instant.</div>';
        return;
    }
    const MOIS = ['jan.','fév.','mars','avr.','mai','juin','juil.','août','sep.','oct.','nov.','déc.'];
    liste.innerHTML = objectifs.map(obj => {
        const evalDate = new Date(obj.dateEval + 'T00:00:00');
        const joursLabel = (obj.joursPlanning || []).map(j => {
            const d = new Date(j + 'T00:00:00');
            return d.getDate() + ' ' + MOIS[d.getMonth()];
        }).join(', ');
        const matiereLabel = obj.matiere ? (ICONES_MATIERES[obj.matiere] || '📦') + ' ' + obj.matiere : '';
        return `
        <div class="objectif-card">
            <div style="font-size:20px;">🎯</div>
            <div class="objectif-info">
                <div class="titre">${echapperHtml(obj.titre)}${matiereLabel ? ' <span style="font-size:11px;font-weight:400;color:var(--gris-texte);">— ' + matiereLabel + '</span>' : ''}</div>
                <div class="dates">Évaluation le ${evalDate.getDate()} ${MOIS[evalDate.getMonth()]} ${evalDate.getFullYear()}</div>
                ${joursLabel ? '<div class="planning-tag">📚 Révisions planifiées : ' + joursLabel + '</div>' : '<div style="font-size:11px;color:var(--gris-texte);">Aucune révision planifiée (dates passées ou non définies)</div>'}
            </div>
            <button class="icon-btn danger" onclick="supprimerObjectif('${obj.id}')">🗑</button>
        </div>`;
    }).join('');
}

/* ================================================================
   RÉVISION FLASHCARDS — une carte à la fois
   ================================================================ */

let flashSession = []; // [{ support, idx }]
let flashIndex = 0;
let modeRevisionFlash = 'reveler'; // 'reveler' | 'lettres' | 'saisie'
let lettresDecoilees = 0;
let lettresTimer = null;
let flashRevele = false;
let flashConfianceChoisie = null; // 'ne-sais-pas' | 'pas-sur' | 'sur'
let flashResultats = { maitrise: 0, satisfaisant: 0, fragile: 0, insuffisant: 0 };

function construireVueRevisionCarte(paires) {
    paires.forEach(item => {
        if (!item.support.etat) item.support.etat = {};
        if (!item.support.etat[item.idx]) {
            item.support.etat[item.idx] = { box: 1, nextDue: todayStr(), indicePerso: '', autoExplication: '' };
        }
    });
    flashSession = melangerTableau([...paires]);
    flashIndex = 0;
    flashRevele = false;
    flashConfianceChoisie = null;
    flashResultats = { maitrise: 0, satisfaisant: 0, fragile: 0, insuffisant: 0 };
    document.getElementById('bandeauFeedback').style.display = 'none';
    document.getElementById('carteFlashcard').style.display = '';
    document.getElementById('finSession').style.display = 'none';
    afficherCarteFlash();
}

function melangerTableau(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function afficherCarteFlash() {
    if (!flashSession.length) return;
    flashRevele = false;
    flashConfianceChoisie = null;
    lettresDecoilees = 0;
    if (lettresTimer) { clearInterval(lettresTimer); lettresTimer = null; }

    // Progression
    const pct = Math.round((flashIndex / flashSession.length) * 100);
    document.getElementById('barreProgressionFlash').style.width = pct + '%';
    document.getElementById('compteurFlash').textContent = (flashIndex + 1) + ' / ' + flashSession.length;

    const item = flashSession[flashIndex % flashSession.length];
    const support = item.support;
    const c = support.cartes[item.idx];
    const etat = support.etat[item.idx];
    const langue = support.langue || 'fr-FR';

    // Badge matière
    const couleursMat = {
        'Anglais':{ bg:'#d1eaff', txt:'#0055aa' },'Histoire-Géo-EMC':{ bg:'#ffe4cc', txt:'#a04800' },
        'Maths':{ bg:'#e0d4ff', txt:'#5500cc' },'SVT':{ bg:'#d4f5dd', txt:'#1a6e30' },
        'Espagnol':{ bg:'#ffd6d6', txt:'#cc0000' },'Latin':{ bg:'#f5e8c8', txt:'#7a5500' },
        'Français':{ bg:'#ffeef5', txt:'#880044' },'Sciences physiques':{ bg:'#e8f0fe', txt:'#1a5276' },
    };
    const couleur = couleursMat[support.matiere] || { bg:'#e8e8e8', txt:'#555' };
    const badge = document.getElementById('badgeMatiereFlash');
    badge.textContent = support.matiere || 'Autre';
    badge.style.background = couleur.bg;
    badge.style.color = couleur.txt;

    // Question
    document.getElementById('questionFlash').textContent = c.question || '';

    // Image question
    const imgEl = document.getElementById('imageFlash');
    const imgSrc = c.questionImage || c.image || '';
    if (imgSrc) { imgEl.src = imgSrc; imgEl.style.display = ''; }
    else imgEl.style.display = 'none';

    // Bouton audio central
    const btnAQ = document.getElementById('btnAudioQuestion');
    btnAQ.onclick = c.questionAudio
        ? () => jouerAudioFlash(c.questionAudio)
        : () => lireTexte(c.question || '', langue, support.voixNom || '');
    btnAQ.classList.remove('playing');

    document.getElementById('zoneConfiance').style.display = '';
    document.querySelectorAll('.conf-btn').forEach(b => b.classList.remove('selected'));

    // Réinitialiser zone réponse
    document.getElementById('zoneReponseFlash').style.display = 'none';
    document.getElementById('reponseFlash').style.display = 'none';
    document.getElementById('reponseFlash').textContent = c.reponse || '';
    document.getElementById('lettresFlash').style.display = 'none';
    document.getElementById('saisieFLashWrap').style.display = 'none';
    document.getElementById('exempleFlash').style.display = 'none';
    document.getElementById('exempleFlash').textContent = c.exemple ? '« ' + c.exemple + ' »' : '';
    document.getElementById('zoneConfirmation').style.display = 'none';

    // Réponse audio
    const btnAR = document.getElementById('btnAudioReponse');
    btnAR.style.display = 'none';
    btnAR.onclick = c.reponseAudio
        ? () => jouerAudioFlash(c.reponseAudio)
        : () => lireTexte(c.reponse || '', langue, support.voixNom || '');

    // Indice (celui saisi à la création de la fiche)
    const indiceProf = document.getElementById('indiceProfFlash');
    indiceProf.innerHTML = c.indice ? '💡 ' + echapperHtml(c.indice) : '';
    document.getElementById('indicePersoFlash').value = etat ? (etat.indicePerso || '') : '';
    document.getElementById('carteFlashcard').classList.remove('indice-ouvert', 'correcte', 'incorrecte');
    // Charger l'audio de l'indice perso si existant
    majUIIndiceAudio(etat && etat.indicePersoAudio ? etat.indicePersoAudio : null);

    animerEntree(document.getElementById('carteFlashcard'), 'anim-entree');
    animerEntree(document.getElementById('zoneConfiance'), 'anim-entree');

    // Mode saisie : pas de confiance, directement la saisie
    if (modeRevisionFlash === 'saisie') {
        document.getElementById('zoneConfiance').style.display = 'none';
        document.getElementById('zoneReponseFlash').style.display = '';
        document.getElementById('saisieFLashWrap').style.display = '';
        document.getElementById('saisieFlash').value = '';
        document.getElementById('feedbackSaisie').textContent = '';
        setTimeout(() => document.getElementById('saisieFlash').focus(), 100);
    }
}

function voirReponseFlash() {
    haptic('select');
    finirRevelationFlash();
}

// Gardé pour compatibilité avec les modes lettres/saisie
function choisirConfiance(valeur, bouton) {
    voirReponseFlash();
}

function revelerCarteFlash() {
    if (flashRevele) return;
    const item = flashSession[flashIndex % flashSession.length];
    const c = item.support.cartes[item.idx];
    if (modeRevisionFlash === 'saisie') return;
    if (modeRevisionFlash === 'lettres') {
        const reponse = c.reponse || '';
        lettresDecoilees++;
        const affichage = reponse.split('').map((ch, i) =>
            i < lettresDecoilees ? ch : (ch === ' ' ? ' ' : '_')
        ).join('');
        document.getElementById('lettresFlash').textContent = affichage;
        document.getElementById('lettresFlash').style.display = '';
        document.getElementById('zoneReponseFlash').style.display = '';
        document.getElementById('zoneConfiance').style.display = 'none';
        if (lettresDecoilees >= reponse.length) finirRevelationFlash();
        return;
    }
    finirRevelationFlash();
}

function jouerAudioFlash(src) {
    const audio = new Audio(src);
    audio.play().catch(() => {});
}

function finirRevelationFlash() {
    flashRevele = true;
    const item = flashSession[flashIndex % flashSession.length];
    const c = item.support.cartes[item.idx];

    document.getElementById('zoneConfiance').style.display = 'none';
    document.getElementById('zoneReponseFlash').style.display = '';
    animerEntree(document.getElementById('zoneReponseFlash'), 'anim-entree');

    const repEl = document.getElementById('reponseFlash');
    repEl.textContent = c.reponse || '';
    repEl.style.display = '';

    if (c.exemple) document.getElementById('exempleFlash').style.display = '';
    document.getElementById('btnAudioReponse').style.display = '';
    if (c.reponseAudio) jouerAudioFlash(c.reponseAudio);

    document.getElementById('texteConfirmation').textContent = "Tu savais ?";
    document.getElementById('zoneConfirmation').style.display = '';
}

function lireQuestionFlash() {
    const item = flashSession[flashIndex % flashSession.length];
    if (!item) return;
    const c = item.support.cartes[item.idx];
    const langue = item.support.langue || 'fr-FR';
    if (c.questionAudio) jouerAudioFlash(c.questionAudio);
    else lireTexte(c.question || '', langue, item.support.voixNom || '');
}

function lireReponseFlash() {
    const item = flashSession[flashIndex % flashSession.length];
    if (!item) return;
    const c = item.support.cartes[item.idx];
    const langue = item.support.langue || 'fr-FR';
    if (c.reponseAudio) jouerAudioFlash(c.reponseAudio);
    else lireTexte(c.reponse || '', langue, item.support.voixNom || '');
}

function evaluerFlash(resultat) {
    if (!flashRevele && modeRevisionFlash !== 'saisie') return;
    const item = flashSession[flashIndex % flashSession.length];
    if (!item.support.etat[item.idx]) {
        item.support.etat[item.idx] = { box: 1, nextDue: todayStr(), indicePerso: '', autoExplication: '' };
    }
    const etat = item.support.etat[item.idx];
    etat.indicePerso = document.getElementById('indicePersoFlash').value;
    // Arrêter un enregistrement en cours si l'élève valide sans avoir arrêté
    if (indiceEnregistrement) arreterEnrIndicePerso();
    const bon = resultat === 'satisfaisant' || resultat === 'maitrise' || resultat === 'oui';
    const moyen = resultat === 'fragile' || resultat === 'moyen';
    majEchecsConsecutifs(etat, bon || moyen);
    // Qualité SM-2 : maîtrise=5, satisfaisant=4, fragile=2, insuffisant=0
    const qualite = (resultat === 'maitrise') ? 5
                  : (resultat === 'satisfaisant' || resultat === 'oui') ? 4
                  : (resultat === 'fragile' || resultat === 'moyen') ? 2
                  : 0;
    // SM-2 tourne toujours — "Statistiques" contrôle seulement ce qui est affiché
    appliquerSM2(etat, qualite);
    sauvegarderSupports();
    if (resultat === 'maitrise') { flashResultats.maitrise++; haptic('success'); }
    else if (resultat === 'satisfaisant' || resultat === 'oui') { flashResultats.satisfaisant++; haptic('select'); }
    else if (resultat === 'fragile' || resultat === 'moyen') { flashResultats.fragile++; haptic('light'); }
    else { flashResultats.insuffisant++; haptic('error'); }
    const bandeau = document.getElementById('bandeauFeedback');
    const prochainJours = etat.intervalle || INTERVALLES[etat.box - 1];
    if (resultat === 'maitrise') {
        bandeau.className = 'bandeau-feedback bon';
        bandeau.textContent = '✅ Très bien ! Prochaine révision dans ' + prochainJours + ' jour' + (prochainJours > 1 ? 's' : '');
    } else if (resultat === 'satisfaisant' || resultat === 'oui') {
        bandeau.className = 'bandeau-feedback bon';
        bandeau.textContent = '✓ Bien ! Prochaine révision dans ' + prochainJours + ' jour' + (prochainJours > 1 ? 's' : '');
    } else if (resultat === 'fragile' || resultat === 'moyen') {
        bandeau.className = 'bandeau-feedback moyen';
        bandeau.textContent = '〜 Fragile — prochaine révision dans ' + prochainJours + ' jour' + (prochainJours > 1 ? 's' : '');
    } else {
        bandeau.className = 'bandeau-feedback mauvais';
        bandeau.textContent = '❌ À retravailler — réponse : ' + (item.support.cartes[item.idx].reponse || '');
    }
    bandeau.style.display = '';
    flashIndex++;
    if (flashIndex >= flashSession.length) {
        afficherFinSessionFlash();
    } else {
        afficherCarteFlash();
    }
}

function verifierSaisieFlash() {
    const saisie = document.getElementById('saisieFlash');
    const item = flashSession[flashIndex % flashSession.length];
    const c = item.support.cartes[item.idx];
    const attendue = normaliserTexteComparaison(c.reponse || '');
    const entree = normaliserTexteComparaison(saisie.value);
    if (!entree) { document.getElementById('feedbackSaisie').textContent = ''; return; }
    const dist = distanceLevenshtein(entree, attendue);
    const seuil = attendue.length <= 4 ? 0 : attendue.length <= 8 ? 1 : 2;
    const fb = document.getElementById('feedbackSaisie');
    if (entree === attendue) {
        fb.textContent = '\u2705 Exact !'; fb.className = 'feedback-saisie bon';
        setTimeout(() => evaluerFlash('oui'), 700);
    } else if (dist <= seuil) {
        fb.textContent = '\U0001F7E1 Presque ! (' + c.reponse + ')'; fb.className = 'feedback-saisie moyen';
        setTimeout(() => evaluerFlash('moyen'), 900);
    } else if (entree.length >= Math.max(3, attendue.length - 2)) {
        fb.textContent = '\u274C Réponse : ' + c.reponse; fb.className = 'feedback-saisie mauvais';
    }
}

function afficherFinSessionFlash() {
    document.getElementById('barreProgressionFlash').style.width = '100%';
    document.getElementById('compteurFlash').textContent = flashSession.length + ' cartes révisées';
    document.getElementById('bandeauFeedback').style.display = 'none';
    document.getElementById('carteFlashcard').style.display = 'none';
    document.getElementById('controlesFlahs').style.display = 'none';
    const fin = document.getElementById('finSession');
    fin.style.display = '';
    document.getElementById('finStats').innerHTML =
        '<div class="fin-stat"><div class="fin-stat-n" style="color:#34C759;">' + flashResultats.maitrise + '</div><div class="fin-stat-l">Réponse immédiate</div></div>' +
        '<div class="fin-stat"><div class="fin-stat-n" style="color:#007AFF;">' + flashResultats.satisfaisant + '</div><div class="fin-stat-l">Après réflexion</div></div>' +
        '<div class="fin-stat"><div class="fin-stat-n" style="color:#FF9500;">' + flashResultats.fragile + '</div><div class="fin-stat-l">Fragile</div></div>' +
        '<div class="fin-stat"><div class="fin-stat-n" style="color:#FF3B30;">' + flashResultats.insuffisant + '</div><div class="fin-stat-l">À retravailler</div></div>';
    document.getElementById('finHint').textContent = (flashResultats.insuffisant + flashResultats.fragile) > 0
        ? 'Reviens demain pour consolider les cartes à retravailler.'
        : 'Excellent ! Continue comme ça.';
}

function recommencerSession() {
    document.getElementById('carteFlashcard').style.display = '';
    document.getElementById('controlesFlahs').style.display = '';
    construireVueRevisionCarte(flashSession);
}

function changerModeRevision(mode) {
    modeRevisionFlash = mode;
    afficherCarteFlash();
}

function toggleIndiceFlash() {
    document.getElementById('carteFlashcard').classList.toggle('indice-ouvert');
}

function afficherResumeBoitesFlash() { /* conservé pour compatibilité */ }

function lancerSessionAujourdhui() {
    const today = todayStr();
    const paires = [];
    supports.forEach(s => {
        if (s.type !== 'texte') return;
        const etat = s.etat || {};
        (s.cartes || []).forEach((c, i) => {
            if (!etat[i]) etat[i] = { box: 1, nextDue: today, indicePerso: '' };
            if (etat[i].nextDue <= today) paires.push({ support: s, idx: i });
        });
    });
    if (!paires.length) { alert("Aucune Flashcard à réviser aujourd'hui."); return; }
    supportActif = null;
    afficherVue('revisionCarte');
    construireVueRevisionCarte(paires);
}

// Fermer exercices
/* ================================================================
   SHEET AJOUTER UN SUPPORT
   ================================================================ */

let ficheContexte = null;

function ouvrirSheetActions(id, nom) {
    ficheContexte = id;
    const titre = document.getElementById('sheetActionsTitre');
    if (titre) titre.textContent = nom || 'Actions';
    document.getElementById('sheetActionsFiche').style.display = '';
}

function fermerSheetActions(ev) {
    if (ev && ev.target !== document.getElementById('sheetActionsFiche')) return;
    document.getElementById('sheetActionsFiche').style.display = 'none';
    // NE PAS remettre ficheContexte à null ici — les actions l'utilisent après la fermeture
}

function actionFiche(action) {
    // Capture l'ID avant fermeture
    const id = ficheContexte;
    ficheContexte = null;
    document.getElementById('sheetActionsFiche').style.display = 'none';
    if (!id) return;
    if (action === 'reviser') ouvrirRevision(id);
    else if (action === 'modifier') ouvrirEdition(id);
    else if (action === 'renommer') ouvrirModifierSupport(id);
    else if (action === 'exporter') exporterSupportId(id);
    else if (action === 'supprimer') supprimerFiche(id);
}

function fermerSheetExportImport(ev) {
    if (ev && ev.target !== document.getElementById('sheetExportImport')) return;
    document.getElementById('sheetExportImport').style.display = 'none';
}

function supprimerFiche(id) {
    const s = supports.find(x => x.id === id);
    if (!s) return;
    if (!confirm('Supprimer définitivement « ' + s.nom + ' » ?')) return;
    supports = supports.filter(x => x.id !== id);
    sauvegarderSupports();
    afficherBibliotheque();
}

function ouvrirSheetAjouter() {
    const sheet = document.getElementById('sheetAjouter');
    if (sheet) sheet.style.display = '';
}

function fermerSheetAjouter(ev) {
    if (ev && ev.target !== document.getElementById('sheetAjouter')) return;
    const sheet = document.getElementById('sheetAjouter');
    if (sheet) sheet.style.display = 'none';
}

// Connecter l'import flash à la feuille
document.addEventListener('DOMContentLoaded', () => {
    // inputImportFlash et inputImportTotal partagent le même handler que inputImport
    ['inputImportFlash', 'inputImportTotal'].forEach(id => {
        const inp = document.getElementById(id);
        if (inp) inp.onchange = (e) => {
            const main = document.getElementById('inputImport');
            if (main && main.onchange) main.onchange(e);
        };
    });
});

/* ================================================================
   ONBOARDING
   ================================================================ */

let obSlideActuel = 1;
let obTypeChoisi = 'texte';

function cacherBannieresSauvegarde() {
    const el = document.getElementById('banniereSauvegarde');
    if (el) el.style.display = 'none';
    // Ne pas re-montrer avant 7 jours même sans sauvegarder
    localStorage.setItem('memo_banniere_ignoree', Date.now().toString());
}

function verifierRappelSauvegarde() {
    if (supports.length === 0) return; // Rien à sauvegarder
    const banniere = document.getElementById('banniereSauvegarde');
    if (!banniere) return;

    const DELAI_SAUVEGARDE = 14 * 24 * 60 * 60 * 1000; // 14 jours
    const DELAI_IGNORE = 7 * 24 * 60 * 60 * 1000;       // 7 jours si ignorée

    const derniereSauvegarde = parseInt(localStorage.getItem('memo_derniere_sauvegarde') || '0');
    const derniereIgnoree = parseInt(localStorage.getItem('memo_banniere_ignoree') || '0');
    const maintenant = Date.now();

    // Ne pas afficher si ignorée il y a moins de 7 jours
    if (derniereIgnoree && maintenant - derniereIgnoree < DELAI_IGNORE) return;

    // Afficher si jamais sauvegardé ou si ça fait plus de 14 jours
    if (!derniereSauvegarde || maintenant - derniereSauvegarde > DELAI_SAUVEGARDE) {
        const texteEl = document.getElementById('texteBanniereSauvegarde');
        if (texteEl) {
            if (!derniereSauvegarde) {
                texteEl.textContent = 'Tu n\'as jamais sauvegardé tes fiches. En cas de problème, tu pourrais tout perdre.';
            } else {
                const joursDepuis = Math.round((maintenant - derniereSauvegarde) / (24 * 60 * 60 * 1000));
                texteEl.textContent = 'Dernière sauvegarde il y a ' + joursDepuis + ' jours — pense à exporter tes fiches.';
            }
        }
        banniere.style.display = 'flex';
    }
}

function verifierOnboarding() {
    const deja = localStorage.getItem('memo_onboarding_v1');
    if (!deja && supports.length === 0) {
        document.getElementById('overlayOnboarding').style.display = 'flex';
    }
}

function avancerOnboarding() {
    if (obSlideActuel < 3) {
        document.getElementById('slide' + obSlideActuel).style.display = 'none';
        obSlideActuel++;
        document.getElementById('slide' + obSlideActuel).style.display = '';
        document.querySelectorAll('.ob-dot').forEach((d, i) => d.classList.toggle('on', i === obSlideActuel - 1));
        const btn = document.getElementById('obBtnSuite');
        const textes = { 1: 'Découvrir →', 2: 'Choisir mon premier support →', 3: "C'est parti 🚀" };
        btn.textContent = textes[obSlideActuel] || "C'est parti 🚀";
    } else {
        terminerOnboarding(obTypeChoisi);
    }
}

function selectTypeOb(type, el) {
    obTypeChoisi = type;
    document.querySelectorAll('.ob-choix-carte').forEach(c => c.classList.remove('selectionne'));
    el.classList.add('selectionne');
}

function terminerOnboarding(type) {
    localStorage.setItem('memo_onboarding_v1', '1');
    document.getElementById('overlayOnboarding').style.display = 'none';
    if (type === 'import') {
        document.getElementById('inputImport').click();
    } else if (type === 'texte' || type === 'image') {
        creerNouveauSupport(type);
    }
}

/* ================================================================
   FIN DE SESSION ENRICHIE
   ================================================================ */

/* ── Indice vocal élève (indice perso enregistré à la voix) ── */

let indiceMediaRecorder = null;
let indiceAudioChunks = [];
let indiceEnregistrement = false;

function toggleEnrIndicePerso() {
    if (indiceEnregistrement) {
        arreterEnrIndicePerso();
    } else {
        demarrerEnrIndicePerso();
    }
}

function demarrerEnrIndicePerso() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("L'enregistrement audio n'est pas disponible sur cet appareil.");
        return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        indiceAudioChunks = [];
        const options = MediaRecorder.isTypeSupported('audio/mp4') ? { mimeType: 'audio/mp4' } :
                        MediaRecorder.isTypeSupported('audio/webm') ? { mimeType: 'audio/webm' } : {};
        indiceMediaRecorder = new MediaRecorder(stream, options);
        indiceMediaRecorder.ondataavailable = e => { if (e.data.size > 0) indiceAudioChunks.push(e.data); };
        indiceMediaRecorder.onstop = () => {
            stream.getTracks().forEach(t => t.stop());
            const blob = new Blob(indiceAudioChunks, { type: indiceMediaRecorder.mimeType });
            const reader = new FileReader();
            reader.onload = ev => {
                const item = flashSession[flashIndex % flashSession.length];
                if (!item) return;
                if (!item.support.etat[item.idx]) return;
                item.support.etat[item.idx].indicePersoAudio = ev.target.result;
                sauvegarderSupports();
                majUIIndiceAudio(ev.target.result);
            };
            reader.readAsDataURL(blob);
            indiceEnregistrement = false;
            const btn = document.getElementById('btnEnrIndicePerso');
            if (btn) { btn.textContent = ''; btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 1a4 4 0 0 1 4 4v7a4 4 0 0 1-8 0V5a4 4 0 0 1 4-4z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="12" y1="19" x2="12" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="8" y1="23" x2="16" y2="23" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Enregistrer ma voix'; btn.classList.remove('enregistrement'); }
        };
        indiceMediaRecorder.start();
        indiceEnregistrement = true;
        const btn = document.getElementById('btnEnrIndicePerso');
        if (btn) { btn.textContent = '⏹ Arrêter'; btn.classList.add('enregistrement'); }
    }).catch(() => alert("Impossible d'accéder au microphone."));
}

function arreterEnrIndicePerso() {
    if (indiceMediaRecorder && indiceMediaRecorder.state === 'recording') {
        indiceMediaRecorder.stop();
    }
}

function majUIIndiceAudio(src) {
    const lecteur = document.getElementById('lecteurIndicePerso');
    const btnSuppr = document.getElementById('btnSuppIndiceAudio');
    if (src) {
        lecteur.src = src;
        lecteur.style.display = '';
        if (btnSuppr) btnSuppr.style.display = '';
    } else {
        lecteur.src = '';
        lecteur.style.display = 'none';
        if (btnSuppr) btnSuppr.style.display = 'none';
    }
}

function supprimerIndiceAudio() {
    const item = flashSession[flashIndex % flashSession.length];
    if (!item || !item.support.etat[item.idx]) return;
    delete item.support.etat[item.idx].indicePersoAudio;
    sauvegarderSupports();
    majUIIndiceAudio(null);
}

/* ── Haptic feedback ── */
function haptic(type) {
    if (!navigator.vibrate) return;
    if (type === 'select') navigator.vibrate(6);
    else if (type === 'success') navigator.vibrate(10);
    else if (type === 'error') navigator.vibrate([20, 40, 20]);
    else if (type === 'light') navigator.vibrate(4);
}

/* ── Animation entrée carte ── */
function animerEntree(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth; // force reflow
    el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

/* ── Bibliothèque : grille de matières + détail par matière (chapitres en accordéon) ── */
let bibliothequeMatiereActive = null; // null = grille des matières ; sinon nom de la matière en cours de détail
let bibliothequeChapitresOuverts = new Set(); // clés "matiere::chapitre" actuellement dépliées

function duesSupport(s) {
    return s.type === 'texte'
        ? (s.cartes || []).filter((c, i) => { const e = s.etat[i]; return !e || estDueDate(e.nextDue); }).length
        : (s.pages || []).reduce((a, p, pi) => a + (p.zones || []).filter((z, zi) => { const e = s.etat[pi + '_' + zi]; return !e || estDueDate(e.nextDue); }).length, 0);
}

function htmlLigneFicheBib(s) {
    const { maitrisees, total } = calculerProgression(s);
    const pct = total > 0 ? Math.round(maitrisees / total * 100) : 0;
    const archive = pct === 100 && total > 0;
    const couleur = pct >= 80 ? '#34C759' : pct >= 40 ? '#FF9500' : '#007AFF';
    return `<div class="bib-support-row" data-id="${s.id}" style="cursor:pointer;">
        ${vignetteSupport(s)
            ? `<img src="${vignetteSupport(s)}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:8px;flex-shrink:0;">`
            : `<div class="bib-support-ic">${s.type === 'texte' ? '🗒️' : '🖼️'}</div>`
        }
        <div class="bib-support-nom">${echapperHtml(s.nom)}${archive ? '<span class="tag-archive">Archivé ✓</span>' : ''}</div>
        <span class="bib-support-pct" style="color:${couleur};">${pct}%</span>
        <button class="btn-actions-fiche" data-fiche-id="${s.id}" data-fiche-nom="${echapperHtml(s.nom).replace(/"/g,'&quot;')}" style="background:none;border:none;font-size:20px;cursor:pointer;padding:4px 10px;color:var(--gris-texte);" type="button">⋯</button>
    </div>`;
}

function afficherBibliotheque(filtre) {
    const liste = document.getElementById('listeBibliotheque');
    if (!liste) return;
    const recherche = (filtre || '').toLowerCase().trim();

    // Trier les supports par matière puis chapitre
    const parMatiere = {};
    supports.forEach(s => {
        const m = s.matiere || 'Autre';
        if (!parMatiere[m]) parMatiere[m] = {};
        const ch = s.chapitre || '—';
        if (!parMatiere[m][ch]) parMatiere[m][ch] = [];
        parMatiere[m][ch].push(s);
    });

    let html;

    if (recherche) {
        // Recherche active : liste plate groupée matière → chapitre, tout déplié,
        // pour retrouver une fiche sans avoir à naviguer dans les tuiles.
        html = Object.keys(parMatiere).sort().map(matiere => {
            const chapitres = parMatiere[matiere];
            const chapHtml = Object.keys(chapitres).sort().map(chap => {
                const supChap = chapitres[chap].filter(s =>
                    (s.nom || '').toLowerCase().includes(recherche) ||
                    (s.chapitre || '').toLowerCase().includes(recherche) ||
                    (s.matiere || '').toLowerCase().includes(recherche)
                );
                if (supChap.length === 0) return '';
                const duesChap = supChap.reduce((n, s) => n + duesSupport(s), 0);
                const badgeHtml = duesChap > 0 ? `<span class="bib-chap-badge due">${duesChap}</span>` : `<span class="bib-chap-badge ok">✓</span>`;
                const chapLabel = chap === '—' ? 'Sans chapitre' : echapperHtml(chap);
                return `<div class="bib-chap-bloc">
                    <div class="bib-chap-header">
                        <div><div class="bib-chap-nom">${chapLabel}</div><div class="bib-chap-meta">${supChap.length} support${supChap.length > 1 ? 's' : ''}</div></div>
                        ${badgeHtml}
                    </div>
                    ${supChap.map(htmlLigneFicheBib).join('')}
                </div>`;
            }).join('');
            if (!chapHtml.trim()) return '';
            return `<div class="bib-mat-section">
                <div class="bib-mat-titre">${ICONES_MATIERES[matiere] || '📦'} ${matiere}</div>
                ${chapHtml}
            </div>`;
        }).join('');
        html = html || '<div class="vide">Aucune fiche trouvée.</div>';

    } else if (bibliothequeMatiereActive && parMatiere[bibliothequeMatiereActive]) {
        // Vue détail d'une matière : en-tête coloré + chapitres en accordéon
        const matiere = bibliothequeMatiereActive;
        const chapitres = parMatiere[matiere];
        const supportsMatiere = Object.values(chapitres).flat();
        const duesMatiere = supportsMatiere.reduce((n, s) => n + duesSupport(s), 0);
        const progMatiere = supportsMatiere.reduce((acc, s) => {
            const { maitrisees, total } = calculerProgression(s);
            acc.mait += maitrisees; acc.total += total; return acc;
        }, { mait: 0, total: 0 });
        const pctMatiere = progMatiere.total > 0 ? Math.round(progMatiere.mait / progMatiere.total * 100) : 0;
        const nomsChap = Object.keys(chapitres).sort();

        const chapHtml = nomsChap.map(chap => {
            const supChap = chapitres[chap];
            const duesChap = supChap.reduce((n, s) => n + duesSupport(s), 0);
            const badgeHtml = duesChap > 0 ? `<span class="bib-chap-badge due">${duesChap}</span>` : `<span class="bib-chap-badge ok">✓</span>`;
            const chapLabel = chap === '—' ? 'Sans chapitre' : echapperHtml(chap);
            const cle = matiere + '::' + chap;
            // Un seul chapitre : pas d'intérêt à le replier.
            const ouvert = nomsChap.length === 1 || bibliothequeChapitresOuverts.has(cle);
            return `<div class="bib-chap-bloc">
                <div class="bib-chap-header" data-chap-key="${echapperHtml(cle)}">
                    <div><div class="bib-chap-nom">${chapLabel}</div><div class="bib-chap-meta">${supChap.length} support${supChap.length > 1 ? 's' : ''}</div></div>
                    <div style="display:flex;align-items:center;">
                        ${badgeHtml}
                        <span class="bib-chap-chevron${ouvert ? ' ouvert' : ''}">›</span>
                    </div>
                </div>
                ${ouvert ? supChap.map(htmlLigneFicheBib).join('') : ''}
            </div>`;
        }).join('');

        html = `<div class="bib-back" data-bib-retour="1">‹ Toutes les matières</div>
            <div class="bib-mat-header" style="background:${gradientMatiere(matiere)};">
                <div class="h-ic">${ICONES_MATIERES[matiere] || '📦'}</div>
                <div>
                    <div class="h-nom">${echapperHtml(matiere)}</div>
                    <div class="h-meta">${supportsMatiere.length} fiche${supportsMatiere.length > 1 ? 's' : ''} · ${duesMatiere} due${duesMatiere > 1 ? 's' : ''} · ${pctMatiere}% maîtrisé</div>
                </div>
            </div>
            ${chapHtml}`;

    } else {
        // Grille des matières (vue par défaut)
        bibliothequeMatiereActive = null;
        const matieresTriees = Object.keys(parMatiere).sort((a, b) => {
            const ia = ORDRE_MATIERES.indexOf(a), ib = ORDRE_MATIERES.indexOf(b);
            return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        });
        const tuiles = matieresTriees.map(matiere => {
            const supportsMatiere = Object.values(parMatiere[matiere]).flat();
            const duesMatiere = supportsMatiere.reduce((n, s) => n + duesSupport(s), 0);
            const prog = supportsMatiere.reduce((acc, s) => {
                const { maitrisees, total } = calculerProgression(s);
                acc.mait += maitrisees; acc.total += total; return acc;
            }, { mait: 0, total: 0 });
            const pct = prog.total > 0 ? Math.round(prog.mait / prog.total * 100) : 0;
            const badge = duesMatiere > 0
                ? `<div class="bib-tuile-badge">${duesMatiere} due${duesMatiere > 1 ? 's' : ''}</div>`
                : `<div class="bib-tuile-badge" style="background:rgba(255,255,255,0.3);">✓ À jour</div>`;
            return `<div class="bib-tuile" data-matiere="${echapperHtml(matiere)}" style="background:${gradientMatiere(matiere)};">
                ${badge}
                <div class="bib-tuile-ic">${ICONES_MATIERES[matiere] || '📦'}</div>
                <div class="bib-tuile-nom">${echapperHtml(matiere)}</div>
                <div class="bib-tuile-meta">${supportsMatiere.length} fiche${supportsMatiere.length > 1 ? 's' : ''}</div>
                <div class="bib-tuile-barre"><div class="bib-tuile-fill" style="width:${pct}%"></div></div>
            </div>`;
        }).join('');
        html = tuiles ? `<div class="bib-tuiles-grid">${tuiles}</div>` : '<div class="vide">Tu n\'as pas encore de fiche. Tape le + pour commencer !</div>';
    }

    liste.innerHTML = html;

    // Délégation événements — écouteur unique — ne pas en ajouter un nouveau à chaque appel
    if (!liste.dataset.listenerInit) {
        liste.dataset.listenerInit = '1';
        liste.addEventListener('click', function(ev) {
            const btnActions = ev.target.closest('.btn-actions-fiche');
            if (btnActions) {
                ev.stopPropagation();
                ouvrirSheetActions(btnActions.dataset.ficheId, btnActions.dataset.ficheNom);
                return;
            }
            const row = ev.target.closest('.bib-support-row[data-id]');
            if (row) {
                ouvrirRevision(row.dataset.id);
                return;
            }
            const tuile = ev.target.closest('.bib-tuile[data-matiere]');
            if (tuile) {
                bibliothequeMatiereActive = tuile.dataset.matiere;
                bibliothequeChapitresOuverts.clear();
                afficherBibliotheque(document.getElementById('bibSearchInput') ? document.getElementById('bibSearchInput').value : '');
                return;
            }
            const retour = ev.target.closest('[data-bib-retour]');
            if (retour) {
                bibliothequeMatiereActive = null;
                afficherBibliotheque('');
                const champ = document.getElementById('bibSearchInput');
                if (champ) champ.value = '';
                return;
            }
            const chapHdr = ev.target.closest('.bib-chap-header[data-chap-key]');
            if (chapHdr) {
                const cle = chapHdr.dataset.chapKey;
                if (bibliothequeChapitresOuverts.has(cle)) bibliothequeChapitresOuverts.delete(cle);
                else bibliothequeChapitresOuverts.add(cle);
                afficherBibliotheque(document.getElementById('bibSearchInput') ? document.getElementById('bibSearchInput').value : '');
            }
        });
    }
}

function filtrerBibliotheque(val) { afficherBibliotheque(val); }

function estDueDate(dateStr) {
    if (!dateStr) return true;
    return dateStr <= todayStr();
}

function migrerVersPagesEtType(liste) {
    let modifie = false;
    liste.forEach(s => {
        if (!s.type) { s.type = 'image'; modifie = true; }
        if (s.type === 'image' && !s.pages) {
            s.pages = [{ image: s.image || '', zones: s.zones || [] }];
            delete s.image;
            delete s.zones;
            // Les anciennes clés d'état (juste l'index de zone) deviennent "0_index" (page 0)
            const nouvelEtat = {};
            Object.keys(s.etat || {}).forEach(k => { nouvelEtat['0_' + k] = s.etat[k]; });
            s.etat = nouvelEtat;
            modifie = true;
        }
        if (s.type === 'texte' && !s.cartes) { s.cartes = []; modifie = true; }
    });
    return modifie;
}

/* ---------------- Démarrage ---------------- */

/* ---------------- Import direct via lien (?import=fichier.json) ---------------- */

async function traiterImportDepuisLien() {
    const params = new URLSearchParams(window.location.search);
    const nomFichier = params.get('import');
    if (!nomFichier) return;

    // On retire le paramètre de l'URL tout de suite, pour ne pas reproposer l'import à chaque rechargement.
    const urlSansParam = window.location.pathname;
    window.history.replaceState({}, '', urlSansParam);

    let urlFichier;
    try { urlFichier = new URL(nomFichier, window.location.href).href; }
    catch (e) { return; }

    let paquet;
    try {
        const reponse = await fetch(urlFichier);
        if (!reponse.ok) throw new Error('introuvable');
        paquet = await reponse.json();
    } catch (e) {
        alert("Impossible de récupérer le paquet à importer (" + nomFichier + "). Vérifie ta connexion ou demande à ton professeur de revérifier le lien.");
        return;
    }

    const liste = Array.isArray(paquet) ? paquet : paquet.supports;
    if (!Array.isArray(liste) || liste.length === 0) {
        alert("Ce lien ne contient pas de paquet valide.");
        return;
    }
    const nomsAffiches = liste.map(s => s.nom || 'Sans titre').join(', ');
    if (!confirm('Importer ce paquet proposé par ton professeur : « ' + nomsAffiches + ' » ?')) return;

    liste.forEach((s) => { supports.push(Object.assign({}, s, { id: genererId() })); });
    migrerVersPagesEtType(supports);
    await sauvegarderSupports();
    afficherAccueil();
    alert('Paquet importé : ' + nomsAffiches);
}

(async function demarrer() {
    supports = await chargerSupports();
    if (migrerVersPagesEtType(supports)) await sauvegarderSupports();
    await mettreAJourStreak();
    preferencesDys = await chargerPreferencesDys();
    appliquerPreferencesDys();
    modulesActifs = await chargerModules();
    appliquerModules();
    objectifs = await chargerObjectifs();
    etiquettesAgenda = await chargerEtiquettesAgenda();
    afficherAccueil();
    afficherBanniereEcranAccueilSiBesoin();
    verifierOnboarding();
    await traiterImportDepuisLien();

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            // updateViaCache: 'none' empêche le navigateur de servir une copie
            // périmée de service-worker.js lui-même depuis le cache HTTP —
            // sans ça, une mise à jour peut ne jamais être détectée.
            navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).then((registration) => {
                // Force une vérification immédiate d'une nouvelle version.
                registration.update();

                // Si une nouvelle version est déjà installée et en attente,
                // on lui demande de prendre la main tout de suite.
                if (registration.waiting) {
                    registration.waiting.postMessage('skipWaiting');
                }

                // Dès qu'une mise à jour est détectée, on l'active sans attendre
                // la fermeture de tous les onglets.
                registration.addEventListener('updatefound', () => {
                    const nouveauSW = registration.installing;
                    if (!nouveauSW) return;
                    nouveauSW.addEventListener('statechange', () => {
                        if (nouveauSW.state === 'installed' && navigator.serviceWorker.controller) {
                            nouveauSW.postMessage('skipWaiting');
                        }
                    });
                });
            }).catch(() => { /* mode hors-ligne indisponible, l'app reste utilisable en ligne */ });

            // Une fois que le nouveau SW a pris le contrôle, on recharge la page
            // une seule fois pour que l'élève obtienne bien le code à jour
            // (app.js déjà chargé en mémoire ne se met pas à jour tout seul).
            let dejaRecharge = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (dejaRecharge) return;
                dejaRecharge = true;
                window.location.reload();
            });
        });
    }
})();
