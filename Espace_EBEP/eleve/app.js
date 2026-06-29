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
    etat.nextDue = addDays(todayStr(), etat.intervalle);
    // "box" reste mis à jour en parallèle (palier visuel 1-5, dérivé de l'intervalle réel) pour l'affichage/les couleurs.
    etat.box = paletVisuelDepuisIntervalle(etat.intervalle);
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

function genererId() {
    return 'sup_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------------- Suivi de série (streak) ---------------- */

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
    if (supports.length === 0) { alert("Tu n'as encore aucun support à exporter."); return; }
    const paquet = { type: 'sauvegarde-memo-revisions', version: 1, exporteLe: new Date().toISOString(), supports: supports };
    const blob = new Blob([JSON.stringify(paquet, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = 'sauvegarde-revisions-' + dateStr + '.json';
    a.click();
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
            alert("Ce fichier n'est pas une sauvegarde valide.");
            return;
        }
        const importes = Array.isArray(paquet) ? paquet : paquet.supports;
        if (!Array.isArray(importes)) {
            alert("Ce fichier n'est pas une sauvegarde valide.");
            return;
        }
        // On ajoute les supports importés sans jamais toucher à ceux déjà présents,
        // et avec de nouveaux identifiants pour éviter tout conflit.
        importes.forEach((s) => {
            supports.push(Object.assign({}, s, { id: genererId() }));
        });
        migrerVersPagesEtType(supports);
        await sauvegarderSupports();
        afficherAccueil();
        alert(importes.length + ' support(s) importé(s) avec succès.');
    };
    reader.readAsText(file);
    e.target.value = '';
};

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

function afficherVue(nom) {
    document.getElementById('vueAccueil').style.display = nom === 'accueil' ? '' : 'none';
    document.getElementById('vueEdition').style.display = nom === 'edition' ? '' : 'none';
    document.getElementById('vueRevision').style.display = nom === 'revision' ? '' : 'none';
    document.getElementById('vueRecadrage').style.display = nom === 'recadrage' ? '' : 'none';
    document.getElementById('vueEditionTexte').style.display = nom === 'editionTexte' ? '' : 'none';
    document.getElementById('vueRevisionTexte').style.display = nom === 'revisionTexte' ? '' : 'none';
    document.getElementById('btnRetour').style.display = (nom === 'accueil' || nom === 'recadrage') ? 'none' : '';
    const btnBascule = document.getElementById('btnBascule');
    if (nom === 'edition') {
        document.getElementById('titreHeader').textContent = supportActif.nom;
        btnBascule.style.display = '';
        btnBascule.textContent = '🧠 Réviser';
        btnBascule.onclick = () => ouvrirRevision(supportActif.id);
    } else if (nom === 'revision') {
        document.getElementById('titreHeader').textContent = supportActif.nom;
        btnBascule.style.display = '';
        btnBascule.textContent = '✏️ Modifier';
        btnBascule.onclick = () => ouvrirEdition(supportActif.id);
    } else if (nom === 'editionTexte') {
        document.getElementById('titreHeader').textContent = supportActif ? supportActif.nom : '';
        btnBascule.style.display = supportActif ? '' : 'none';
        btnBascule.textContent = '🧠 Réviser';
        if (supportActif) btnBascule.onclick = () => ouvrirRevision(supportActif.id);
    } else if (nom === 'revisionTexte') {
        document.getElementById('titreHeader').textContent = supportActif ? supportActif.nom : '🔀 Session mélangée';
        btnBascule.style.display = supportActif ? '' : 'none';
        btnBascule.textContent = '✏️ Modifier';
        if (supportActif) btnBascule.onclick = () => ouvrirEdition(supportActif.id);
    } else if (nom === 'recadrage') {
        document.getElementById('titreHeader').textContent = 'Cadrage';
        btnBascule.style.display = 'none';
    } else {
        document.getElementById('titreHeader').textContent = 'Mes révisions';
        btnBascule.style.display = 'none';
    }
    vueActuelle = nom;
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
    const conteneur = document.getElementById('tableauBordAujourdhui');
    if (!conteneur) return;
    if (supports.length === 0) { conteneur.style.display = 'none'; return; }
    conteneur.style.display = '';
    const r = calculerResumeAujourdhui();
    let texteResume;
    if (r.total === 0) {
        texteResume = '✅ Tout est à jour ! Rien à réviser aujourd\'hui.';
    } else {
        const plafonne = r.total > PLAFOND_PAR_JOUR;
        texteResume = '<strong>' + Math.min(r.total, PLAFOND_PAR_JOUR) + '</strong> élément(s) à réviser aujourd\'hui'
            + (r.dueImage && r.dueTexte ? ' (' + r.dueImage + ' zones d\'image, ' + r.dueTexte + ' cartes texte)' : '')
            + ' dans <strong>' + r.supports + '</strong> support(s)'
            + (plafonne ? '<br><span style="color:var(--gris-texte);">+' + (r.total - PLAFOND_PAR_JOUR) + ' autres reportés à demain pour éviter la surcharge</span>' : '');
    }
    conteneur.innerHTML = '<div class="streak">🔥 ' + streakActuel.jours + '<small>jour' + (streakActuel.jours === 1 ? '' : 's') + ' de suite</small></div>'
        + '<div class="resume-du-jour">' + texteResume + '</div>';
}

function afficherAccueil() {
    afficherVue('accueil');
    afficherTableauBord();
    const liste = document.getElementById('listeSupports');
    if (supports.length === 0) {
        liste.innerHTML = '<div class="vide">Tu n\u2019as pas encore de support. Crée-en un pour commencer à réviser !</div>';
    } else {
        const parMatiere = {};
        supports.forEach(s => {
            const m = s.matiere || 'Autre';
            if (!parMatiere[m]) parMatiere[m] = [];
            parMatiere[m].push(s);
        });
        const matieresPresentes = ORDRE_MATIERES.filter(m => parMatiere[m]);
        Object.keys(parMatiere).forEach(m => { if (!matieresPresentes.includes(m)) matieresPresentes.push(m); });

        liste.innerHTML = matieresPresentes.map(m => `
            <div class="titre-matiere">${ICONES_MATIERES[m] || '📦'} ${m}</div>
            ${parMatiere[m].slice().reverse().map(s => `
                <div class="carte-support" data-id="${s.id}">
                    ${vignetteSupport(s) ? `<img src="${vignetteSupport(s)}" alt="">` : `<div style="width:56px;height:56px;border-radius:10px;background:var(--gris-fond);display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">${s.type === 'texte' ? '🗒️' : '🖼️'}</div>`}
                    <div class="infos">
                        <div class="nom"></div>
                        <div class="barre-progression"><div class="barre-remplie" data-id-barre="${s.id}"></div></div>
                        <div class="meta" data-id-meta="${s.id}"></div>
                    </div>
                    <button class="icon-btn" data-modifier="${s.id}" style="flex-shrink:0;">✏️</button>
                    <button class="icon-btn danger" data-suppr="${s.id}" style="flex-shrink:0;">🗑</button>
                    <div class="chevron">›</div>
                </div>
            `).join('')}
        `).join('');

        liste.querySelectorAll('.carte-support').forEach(carte => {
            const id = carte.getAttribute('data-id');
            const s = supports.find(x => x.id === id);
            carte.querySelector('.nom').textContent = s.nom + (s.type === 'image' && s.pages && s.pages.length > 1 ? ' (' + s.pages.length + ' pages)' : '');
            const { maitrisees, total, difficiles } = calculerProgression(s);
            const pct = total > 0 ? Math.round((maitrisees / total) * 100) : 0;
            carte.querySelector('[data-id-barre="' + id + '"]').style.width = pct + '%';
            const unite = s.type === 'texte' ? ' cartes maîtrisées' : ' zones maîtrisées';
            carte.querySelector('[data-id-meta="' + id + '"]').textContent = total === 0 ? 'Pas encore de contenu' : maitrisees + '/' + total + unite + (difficiles > 0 ? ' · ⚠️ ' + difficiles + ' difficile' + (difficiles > 1 ? 's' : '') : '');
            carte.addEventListener('click', (ev) => {
                if (ev.target.closest('[data-suppr]') || ev.target.closest('[data-modifier]')) return;
                ouvrirRevision(id);
            });
        });
        liste.querySelectorAll('[data-suppr]').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const id = btn.getAttribute('data-suppr');
                const s = supports.find(x => x.id === id);
                if (!confirm('Supprimer définitivement « ' + (s ? s.nom : '') + ' » ?')) return;
                supports = supports.filter(x => x.id !== id);
                sauvegarderSupports();
                afficherAccueil();
            });
        });
        liste.querySelectorAll('[data-modifier]').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ouvrirModifierSupport(btn.getAttribute('data-modifier'));
            });
        });
    }
    afficherEspaceStockage();
}

async function afficherEspaceStockage() {
    const el = document.getElementById('espaceStockage');
    if (!el) return;
    if (navigator.storage && navigator.storage.estimate) {
        try {
            const estim = await navigator.storage.estimate();
            const usageMo = (estim.usage / (1024 * 1024)).toFixed(1);
            if (estim.quota) {
                const quotaMo = Math.round(estim.quota / (1024 * 1024));
                const pct = Math.min(100, Math.round((estim.usage / estim.quota) * 100));
                el.textContent = '💾 Espace utilisé : ' + usageMo + ' Mo / ~' + quotaMo + ' Mo (' + pct + '%)';
            } else {
                el.textContent = '💾 Espace utilisé : ' + usageMo + ' Mo';
            }
        } catch (e) {
            el.textContent = '';
        }
    } else {
        el.textContent = '';
    }
}

function definirTexte(id, texte) {
    const el = document.getElementById(id);
    if (el) el.textContent = texte;
}

let idSupportEnEdition = null;

function creerNouveauSupport() {
    idSupportEnEdition = null;
    definirTexte('titreModalSupport', 'Nouveau support');
    definirTexte('btnValiderSupport', 'Créer');
    document.getElementById('champNomSupport').value = '';
    document.getElementById('champMatiereSupport').value = 'Français';
    document.getElementById('champTypeSupport').value = 'image';
    document.getElementById('ligneTypeSupport').style.display = '';
    document.getElementById('modalNouveauSupport').classList.add('ouverte');
    setTimeout(() => document.getElementById('champNomSupport').focus(), 50);
}

function ouvrirModifierSupport(id) {
    const s = supports.find(x => x.id === id);
    if (!s) return;
    idSupportEnEdition = id;
    definirTexte('titreModalSupport', 'Modifier le support');
    definirTexte('btnValiderSupport', 'Enregistrer');
    document.getElementById('champNomSupport').value = s.nom;
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

    if (idSupportEnEdition) {
        const s = supports.find(x => x.id === idSupportEnEdition);
        if (s) {
            s.nom = nom;
            s.matiere = matiere;
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
            alert("Ce support n'a pas encore de carte. Ajoute-en d'abord.");
            ouvrirEdition(id);
            return;
        }
        afficherVue('revisionTexte');
        construireVueRevisionTexte();
        return;
    }
    const totalZones = (supportActif.pages || []).reduce((acc, p) => acc + p.zones.length, 0);
    if (!supportActif.pages || supportActif.pages.length === 0 || totalZones === 0) {
        alert("Ce support n'a pas encore d'image ou de zones. Ajoute-les d'abord.");
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
    if (el) el.textContent = 'Page ' + (pageActuelle + 1) + '/' + total;
    const btnPrec = document.getElementById(prefixeId + 'PagePrecedente');
    const btnSuiv = document.getElementById(prefixeId + 'PageSuivante');
    if (btnPrec) btnPrec.disabled = (pageActuelle === 0);
    if (btnSuiv) btnSuiv.disabled = (pageActuelle === total - 1);
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
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.js';
        script.onload = () => {
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js';
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
            for (let n = 1; n <= pdf.numPages; n++) {
                const page = await pdf.getPage(n);
                const viewport = page.getViewport({ scale: 2 });
                const canvasPage = document.createElement('canvas');
                canvasPage.width = viewport.width;
                canvasPage.height = viewport.height;
                await page.render({ canvasContext: canvasPage.getContext('2d'), viewport: viewport }).promise;
                const finalCanvas = redimensionnerCanvas(canvasPage, 1280);
                ajouterPageDepuisImage(finalCanvas.toDataURL('image/jpeg', 0.85));
            }
        } catch (err) {
            alert('Erreur lors de la lecture du PDF : ' + err.message);
        }
    };
    reader.readAsArrayBuffer(file);
};

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
    let sx = 0, sy = 0, sw = imgRecadrageNaturalW, sh = imgRecadrageNaturalH;
    if (cropRect) {
        sx = cropRect.xPct / 100 * imgRecadrageNaturalW;
        sy = cropRect.yPct / 100 * imgRecadrageNaturalH;
        sw = cropRect.wPct / 100 * imgRecadrageNaturalW;
        sh = cropRect.hPct / 100 * imgRecadrageNaturalH;
    }
    const maxW = 1280;
    let w = sw, h = sh;
    if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
    const c = document.createElement('canvas');
    c.width = Math.round(w); c.height = Math.round(h);
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    callback(c.toDataURL('image/jpeg', 0.82));
}

function validerCadrage() {
    appliquerCadrageEtStocker((dataUrlFinal) => {
        afficherVue('edition');
        ajouterPageDepuisImage(dataUrlFinal);
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
    const maxL = Math.min(window.innerWidth * 0.9, 1050);
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

        const conteneur = document.createElement('div');
        conteneur.className = 'rect';
        conteneur.style.left = left + 'px';
        conteneur.style.top = top + 'px';
        conteneur.style.width = largeur + 'px';
        conteneur.style.height = hauteur + 'px';

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
            poly.setAttribute('fill', 'rgba(52,152,219,0.2)');
            poly.setAttribute('stroke', '#3498db');
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
        <input type="text" id="champBulleIndice" placeholder="Ex : verbe, commence par É...">
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

function todayStr() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString().slice(0, 10); }
function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
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
    document.querySelectorAll('#segmente .mode-btn').forEach(b => b.classList.toggle('actif', b.dataset.mode === mode));
    document.querySelector('#segmente .thumb').classList.toggle('pos-1', mode === 'complet');
    document.body.classList.remove('filtre-actif');
    document.getElementById('btnFiltre').textContent = '📅 Zones à réviser';

    chargerPageRevision();
}

function pagePrecedenteRevision() {
    if (pageActuelle > 0) { pageActuelle--; chargerPageRevision(); }
}
function pageSuivanteRevision() {
    if (pageActuelle < supportActif.pages.length - 1) { pageActuelle++; chargerPageRevision(); }
}

function chargerPageRevision() {
    const page = supportActif.pages[pageActuelle];
    const conteneur = document.getElementById('conteneurImage');
    conteneur.innerHTML = '';
    const img = document.createElement('img');
    img.src = page.image;
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

        const fond = document.createElement('div');
        fond.className = 'fond';
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
        indiceBtn.addEventListener('click', (ev) => { ev.stopPropagation(); masque.classList.toggle('indice-actif'); });
        masque.appendChild(indiceBtn);

        const panel = document.createElement('div');
        panel.className = 'indice-panel' + (z.yPct < 12 ? ' dessous' : '');
        panel.addEventListener('click', (ev) => ev.stopPropagation());
        if (z.indice) {
            const prof = document.createElement('div');
            prof.className = 'indice-prof';
            prof.textContent = '👩\u200d🏫 ' + z.indice;
            panel.appendChild(prof);
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
        inputPerso.addEventListener('input', () => { etatRevision[cle].indicePerso = inputPerso.value; sauvegarderSupports(); });
        panel.appendChild(inputPerso);
        masque.appendChild(panel);

        const declare = document.createElement('div');
        declare.className = 'declare' + (z.yPct < 12 ? ' dessous' : '');
        declare.addEventListener('click', (ev) => ev.stopPropagation());
        const btnOk = document.createElement('button');
        btnOk.className = 'btn-ok';
        btnOk.textContent = '✓';
        btnOk.addEventListener('click', (ev) => { ev.stopPropagation(); declarer(masque, true); });
        const btnNon = document.createElement('button');
        btnNon.className = 'btn-non';
        btnNon.textContent = '✗';
        btnNon.addEventListener('click', (ev) => { ev.stopPropagation(); declarer(masque, false); });
        declare.appendChild(btnOk);
        declare.appendChild(btnNon);
        masque.appendChild(declare);

        conteneur.appendChild(masque);
    });

    majNavigateurPages('revision');
    actualiserAffichageRevision();
}

function toggleRevele(masque) { masque.classList.toggle('revele'); }

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

function declarer(masque, bon) {
    masque.classList.remove('correcte', 'incorrecte');
    masque.classList.add(bon ? 'correcte' : 'incorrecte');
    const cle = masque.dataset.cle;
    majEchecsConsecutifs(etatRevision[cle], bon);
    etatRevision[cle].box = bon ? Math.min(5, etatRevision[cle].box + 1) : 1;
    etatRevision[cle].nextDue = addDays(todayStr(), INTERVALLES[etatRevision[cle].box - 1]);
    sauvegarderSupports();
    majCompteurRevision();
    afficherToast(bon, document.querySelectorAll('#conteneurImage .masque').length);
    actualiserAffichageRevision();
}

function actualiserAffichageRevision() {
    document.querySelectorAll('#conteneurImage .masque').forEach(m => {
        const cle = m.dataset.cle;
        const e = etatRevision[cle];
        const niveau = m.querySelector('.boite-niveau');
        niveau.textContent = e.box;
        niveau.className = 'boite-niveau niveau-' + e.box;
        m.classList.toggle('due', estDue(cle));
        m.classList.toggle('difficile', !!e.difficile);
    });
    majCompteurRevision();
    actualiserResumeBoites();
}

function majCompteurRevision() {
    const total = document.querySelectorAll('#conteneurImage .masque').length;
    const bonnes = document.querySelectorAll('#conteneurImage .masque.correcte').length;
    const mauvaises = document.querySelectorAll('#conteneurImage .masque.incorrecte').length;
    const suffixe = supportActif.pages.length > 1 ? ' zones, cette page)' : ' zones, cette session)';
    document.getElementById('compteurRevision').textContent = '✅ ' + bonnes + '   ❌ ' + mauvaises + '   (sur ' + total + suffixe;
}

function actualiserResumeBoites() {
    const counts = [0, 0, 0, 0, 0], duesParBoite = [0, 0, 0, 0, 0];
    let total = 0, duesTotal = 0;
    supportActif.pages.forEach((page, pi) => {
        page.zones.forEach((z, zi) => {
            const cle = pi + '_' + zi;
            const b = etatRevision[cle].box;
            counts[b - 1]++;
            total++;
            if (estDue(cle)) { duesParBoite[b - 1]++; duesTotal++; }
        });
    });
    const labels = ['Tous les jours', 'Dans 1 jour', 'Dans 3 jours', 'Dans 7 jours', 'Dans 16 jours ou plus'];
    let html = '<div class="boites-titre">📦 Mes boîtes de révision</div><div class="boites-rangee">';
    for (let b = 1; b <= 5; b++) {
        const due = duesParBoite[b - 1] > 0;
        html += '<div class="boite-card boite-card-' + b + (due ? ' due-card' : '') + '">'
            + '<div class="boite-num">Boîte ' + b + '</div>'
            + '<div class="boite-count">' + counts[b - 1] + '</div>'
            + '<div class="boite-label">' + labels[b - 1] + '</div>'
            + (due ? '<div class="boite-flag">📅 à revoir</div>' : '')
            + '</div>';
        if (b < 5) html += '<div class="boite-fleche">→</div>';
    }
    html += '</div><div class="boites-legende">← zones fragiles, revues souvent &nbsp;|&nbsp; zones maîtrisées, espacées →</div>';
    html += '<div class="boites-resume-txt">📅 ' + duesTotal + " zone(s) à réviser aujourd'hui sur " + total + ' (toutes pages confondues)</div>';
    document.getElementById('resumeBoites').innerHTML = html;
}

function remasquerToutRevision() {
    document.querySelectorAll('#conteneurImage .masque').forEach(m => m.classList.remove('revele', 'correcte', 'incorrecte'));
    majCompteurRevision();
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
    document.querySelector('#segmente .thumb').classList.toggle('pos-1', mode === 'complet');
    if (mode === 'simple') {
        document.body.classList.remove('filtre-actif');
        document.getElementById('btnFiltre').textContent = '📅 Zones à réviser';
    }
    sauvegarderSupports();
}

/* ---------------- Mode Texte : édition des cartes question/réponse ---------------- */

function chargerEditionTexte() {
    document.getElementById('titreHeader').textContent = supportActif.nom;
    const conteneur = document.getElementById('listeCartesTexte');
    document.getElementById('champLangueSupport').value = supportActif.langue || 'fr-FR';
    if (supportActif.cartes.length === 0) {
        conteneur.innerHTML = '<div class="vide" style="padding:20px 10px;">Aucune carte pour l\'instant. Ajoute ta première question/réponse.</div>';
    } else {
        conteneur.innerHTML = supportActif.cartes.map((c, i) => `
            <div class="ligne-carte-texte">
                <div class="champs-carte-empiles">
                    <div class="champ-carte">
                        <span class="label-modale">Question</span>
                        <input type="text" class="champ-modale input-question" data-idx="${i}" value="${echapperHtml(c.question || '')}" placeholder="Ex : Capitale de l'Espagne">
                    </div>
                    <div class="champ-carte">
                        <span class="label-modale">Réponse</span>
                        <input type="text" class="champ-modale input-reponse" data-idx="${i}" value="${echapperHtml(c.reponse || '')}" placeholder="Ex : Madrid">
                    </div>
                    <div class="champ-carte">
                        <span class="label-modale">Phrase d'exemple (facultatif)</span>
                        <input type="text" class="champ-modale input-exemple" data-idx="${i}" value="${echapperHtml(c.exemple || '')}" placeholder="Ex : Madrid es la capital de España.">
                    </div>
                </div>
                <button class="icon-btn danger" data-suppr-carte="${i}">🗑</button>
            </div>
        `).join('');
        conteneur.querySelectorAll('.input-question').forEach(inp => inp.addEventListener('input', () => {
            supportActif.cartes[parseInt(inp.dataset.idx, 10)].question = inp.value;
            sauvegarderSupports();
        }));
        conteneur.querySelectorAll('.input-reponse').forEach(inp => inp.addEventListener('input', () => {
            supportActif.cartes[parseInt(inp.dataset.idx, 10)].reponse = inp.value;
            sauvegarderSupports();
        }));
        conteneur.querySelectorAll('.input-exemple').forEach(inp => inp.addEventListener('input', () => {
            supportActif.cartes[parseInt(inp.dataset.idx, 10)].exemple = inp.value;
            sauvegarderSupports();
        }));
        conteneur.querySelectorAll('[data-suppr-carte]').forEach(btn => btn.addEventListener('click', () => {
            supportActif.cartes.splice(parseInt(btn.dataset.supprCarte, 10), 1);
            sauvegarderSupports();
            chargerEditionTexte();
        }));
    }
    definirTexte('compteurCartesTexte', supportActif.cartes.length + ' carte' + (supportActif.cartes.length === 1 ? '' : 's'));
}

function changerLangueSupport(valeur) {
    if (!supportActif) return;
    supportActif.langue = valeur;
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

function lireTexte(texte, langue) {
    if (!texte) return;
    if (!('speechSynthesis' in window)) { alert("La lecture audio n'est pas disponible sur cet appareil."); return; }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(texte);
    utter.lang = langue || 'fr-FR';
    window.speechSynthesis.speak(utter);
}

function creerElementCarte(support, idx) {
    const c = support.cartes[idx];
    const etat = support.etat[idx];
    const langue = support.langue || 'fr-FR';

    const carte = document.createElement('div');
    carte.className = 'carte-revision-texte';
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
    btnAudioQ.addEventListener('click', (ev) => { ev.stopPropagation(); lireTexte(c.question, langue); });
    question.appendChild(btnAudioQ);
    if (modeSessionMelangee) {
        const etiquette = document.createElement('div');
        etiquette.className = 'etiquette-support-melange';
        etiquette.textContent = '📂 ' + support.nom;
        carte.appendChild(etiquette);
    }
    carte.appendChild(question);

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

    const reponseWrap = document.createElement('div');
    reponseWrap.className = 'reponse-wrap';

    const niveau = document.createElement('div');
    niveau.className = 'boite-niveau';
    reponseWrap.appendChild(niveau);

    const reponse = document.createElement('div');
    reponse.className = 'reponse-texte';
    reponse.textContent = c.reponse;
    reponseWrap.appendChild(reponse);

    if (c.exemple) {
        const exemple = document.createElement('div');
        exemple.className = 'exemple-texte';
        exemple.textContent = '« ' + c.exemple + ' »';
        reponseWrap.appendChild(exemple);
    }

    const btnAudioR = document.createElement('button');
    btnAudioR.className = 'btn-audio btn-audio-reponse';
    btnAudioR.textContent = '🔊';
    btnAudioR.addEventListener('click', (ev) => { ev.stopPropagation(); lireTexte(c.reponse, langue); });
    reponseWrap.appendChild(btnAudioR);

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
    inputPerso.addEventListener('input', () => { etat.indicePerso = inputPerso.value; sauvegarderSupports(); });
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
    inputExplication.addEventListener('input', () => { etat.autoExplication = inputExplication.value; sauvegarderSupports(); });
    explicationWrap.appendChild(inputExplication);
    carte.appendChild(explicationWrap);

    return carte;
}

function construireVueRevisionTexte() {
    document.getElementById('titreHeader').textContent = supportActif.nom;
    modeSessionMelangee = false;
    initEtatRevisionTexte();

    document.getElementById('barreModeTexte').style.display = '';
    document.getElementById('controlesSeulTexte').style.display = '';

    const mode = supportActif.mode || 'simple';
    document.body.classList.toggle('mode-simple', mode === 'simple');
    document.querySelectorAll('#segmenteTexte .mode-btn').forEach(b => b.classList.toggle('actif', b.dataset.mode === mode));
    document.querySelector('#segmenteTexte .thumb').classList.toggle('pos-1', mode === 'complet');
    document.body.classList.remove('filtre-actif');
    document.getElementById('btnFiltreTexte').textContent = '📅 Cartes à réviser';

    const conteneur = document.getElementById('listeRevisionTexte');
    conteneur.innerHTML = '';
    supportActif.cartes.forEach((c, i) => conteneur.appendChild(creerElementCarte(supportActif, i)));

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
        alert("Aucune carte à réviser aujourd'hui parmi tes supports Texte. Reviens plus tard, ou ouvre un support en particulier pour réviser par anticipation.");
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
    afficherVue('revisionTexte');
    document.getElementById('titreHeader').textContent = '🔀 Session mélangée';
    document.getElementById('barreModeTexte').style.display = 'none';
    document.getElementById('controlesSeulTexte').style.display = 'none';
    document.body.classList.remove('mode-simple', 'filtre-actif');

    const conteneur = document.getElementById('listeRevisionTexte');
    conteneur.innerHTML = '';
    if (nbReportees > 0) {
        const note = document.createElement('div');
        note.style.cssText = 'font-size:13px; color:var(--gris-texte); text-align:center; margin-bottom:14px;';
        note.textContent = '📦 ' + nbReportees + " carte(s) en plus sont dues aujourd'hui mais reportées à demain pour éviter la surcharge — reviens demain pour continuer.";
        conteneur.appendChild(note);
    }
    paireRetenues.forEach(p => conteneur.appendChild(creerElementCarte(p.support, p.idx)));
    actualiserAffichageRevisionTexte();
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
    document.getElementById('compteurRevisionTexte').textContent = '✅ ' + bonnes + '   ❌ ' + mauvaises + '   (sur ' + total + ' cartes, cette session)';
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
    const labels = ['Tous les jours', 'Dans 1 jour', 'Dans 3 jours', 'Dans 7 jours', 'Dans 16 jours ou plus'];
    let html = '<div class="boites-titre">📦 Mes boîtes de révision</div><div class="boites-rangee">';
    for (let b = 1; b <= 5; b++) {
        const due = duesParBoite[b - 1] > 0;
        html += '<div class="boite-card boite-card-' + b + (due ? ' due-card' : '') + '">'
            + '<div class="boite-num">Boîte ' + b + '</div>'
            + '<div class="boite-count">' + counts[b - 1] + '</div>'
            + '<div class="boite-label">' + labels[b - 1] + '</div>'
            + (due ? '<div class="boite-flag">📅 à revoir</div>' : '')
            + '</div>';
        if (b < 5) html += '<div class="boite-fleche">→</div>';
    }
    html += '</div><div class="boites-legende">← cartes fragiles, revues souvent &nbsp;|&nbsp; cartes maîtrisées, espacées →</div>';
    html += '<div class="boites-resume-txt">📅 ' + duesTotal + " carte(s) à réviser aujourd'hui sur " + total + '</div>';
    document.getElementById('resumeBoitesTexte').innerHTML = html;
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

(async function demarrer() {
    supports = await chargerSupports();
    if (migrerVersPagesEtType(supports)) await sauvegarderSupports();
    await mettreAJourStreak();
    afficherAccueil();
    afficherBanniereEcranAccueilSiBesoin();

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('service-worker.js').catch(() => { /* mode hors-ligne indisponible, l'app reste utilisable en ligne */ });
        });
    }
})();
