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
const INTERVALLES = [0, 1, 3, 7, 16]; // jours avant prochaine révision, indexé sur (boîte - 1)
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
    const total = s.zones.length;
    let maitrisees = 0;
    for (let i = 0; i < total; i++) {
        const e = s.etat && s.etat[i];
        if (e && e.box >= 4) maitrisees++;
    }
    return { maitrisees, total };
}

function afficherAccueil() {
    afficherVue('accueil');
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
                    <img src="${s.image || ''}" alt="">
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
            carte.querySelector('.nom').textContent = s.nom;
            const { maitrisees, total } = calculerProgression(s);
            const pct = total > 0 ? Math.round((maitrisees / total) * 100) : 0;
            carte.querySelector('[data-id-barre="' + id + '"]').style.width = pct + '%';
            carte.querySelector('[data-id-meta="' + id + '"]').textContent = total === 0 ? 'Pas encore de zone' : maitrisees + '/' + total + ' zones maîtrisées';
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

    const support = {
        id: genererId(),
        nom: nom,
        matiere: matiere,
        image: '',
        zones: [],
        etat: {},
        mode: 'simple',
        creeLe: Date.now()
    };
    supports.push(support);
    sauvegarderSupports();
    fermerModalNouveauSupport();
    ouvrirEdition(support.id);
}

function ouvrirEdition(id) {
    supportActif = supports.find(s => s.id === id);
    if (!supportActif) return;
    afficherVue('edition');
    chargerCanvasEdition();
}

function ouvrirRevision(id) {
    supportActif = supports.find(s => s.id === id);
    if (!supportActif) return;
    if (!supportActif.image || supportActif.zones.length === 0) {
        alert("Ce support n'a pas encore d'image ou de zones. Ajoute-les d'abord.");
        ouvrirEdition(id);
        return;
    }
    afficherVue('revision');
    construireVueRevision();
}

/* ---------------- Édition : image, zoom, zones ---------------- */

function chargerCanvasEdition() {
    canvasEl.innerHTML = '';
    if (supportActif.image) {
        const img = document.createElement('img');
        img.onload = () => {
            imgNaturalW = img.naturalWidth;
            imgNaturalH = img.naturalHeight;
            zoomReset();
            redessinerZonesEdition();
        };
        img.src = supportActif.image;
        canvasEl.appendChild(img);
    }
    majCompteurZonesEdition();
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
        supportActif.image = dataUrlFinal;
        supportActif.zones = [];
        sauvegarderSupports();
        afficherVue('edition');
        chargerCanvasEdition();
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

        supportActif.zones.push({
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

    supportActif.zones.push({
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
    const zones = supportActif.zones;
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
    if (!supportActif || supportActif.zones.length === 0) return;
    supportActif.zones.pop();
    redessinerZonesEdition();
    majCompteurZonesEdition();
    sauvegarderSupports();
}

function effacerToutesZones() {
    if (!supportActif) return;
    supportActif.zones = [];
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
    supportActif.zones.forEach((z, i) => {
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
    const n = supportActif.zones.length;
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
    const z = supportActif.zones[idxZone];
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
        supportActif.zones[idxZone].indice = champ.value.trim();
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

/* ---------------- Révision (Leitner) ---------------- */

function todayStr() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString().slice(0, 10); }
function addDays(dateStr, n) { const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function estDue(i) { return etatRevision[i].nextDue <= todayStr(); }

function construireVueRevision() {
    etatRevision = supportActif.etat || (supportActif.etat = {});
    const total = supportActif.zones.length;
    for (let i = 0; i < total; i++) {
        if (!etatRevision[i]) etatRevision[i] = { box: 1, nextDue: todayStr(), indicePerso: '' };
        if (etatRevision[i].indicePerso === undefined) etatRevision[i].indicePerso = '';
    }
    sauvegarderSupports();

    const mode = supportActif.mode || 'simple';
    document.body.classList.toggle('mode-simple', mode === 'simple');
    document.querySelectorAll('#segmente .mode-btn').forEach(b => b.classList.toggle('actif', b.dataset.mode === mode));
    document.querySelector('#segmente .thumb').classList.toggle('pos-1', mode === 'complet');
    document.body.classList.remove('filtre-actif');
    document.getElementById('btnFiltre').textContent = '📅 Zones à réviser';

    const conteneur = document.getElementById('conteneurImage');
    conteneur.innerHTML = '';
    const img = document.createElement('img');
    img.src = supportActif.image;
    conteneur.appendChild(img);

    supportActif.zones.forEach((z, i) => {
        const masque = document.createElement('div');
        masque.className = 'masque';
        masque.dataset.idx = i;
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
        inputPerso.value = etatRevision[i].indicePerso || '';
        inputPerso.addEventListener('input', () => { etatRevision[i].indicePerso = inputPerso.value; sauvegarderSupports(); });
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
    const i = masque.dataset.idx;
    etatRevision[i].box = bon ? Math.min(5, etatRevision[i].box + 1) : 1;
    etatRevision[i].nextDue = addDays(todayStr(), INTERVALLES[etatRevision[i].box - 1]);
    sauvegarderSupports();
    majCompteurRevision();
    afficherToast(bon, supportActif.zones.length);
    actualiserAffichageRevision();
}

function actualiserAffichageRevision() {
    document.querySelectorAll('#conteneurImage .masque').forEach(m => {
        const i = m.dataset.idx;
        const e = etatRevision[i];
        const niveau = m.querySelector('.boite-niveau');
        niveau.textContent = e.box;
        niveau.className = 'boite-niveau niveau-' + e.box;
        m.classList.toggle('due', estDue(i));
    });
    majCompteurRevision();
    actualiserResumeBoites();
}

function majCompteurRevision() {
    const total = supportActif.zones.length;
    const bonnes = document.querySelectorAll('#conteneurImage .masque.correcte').length;
    const mauvaises = document.querySelectorAll('#conteneurImage .masque.incorrecte').length;
    document.getElementById('compteurRevision').textContent = '✅ ' + bonnes + '   ❌ ' + mauvaises + '   (sur ' + total + ' zones, cette session)';
}

function actualiserResumeBoites() {
    const total = supportActif.zones.length;
    const counts = [0, 0, 0, 0, 0], duesParBoite = [0, 0, 0, 0, 0];
    let duesTotal = 0;
    for (let i = 0; i < total; i++) {
        const b = etatRevision[i].box;
        counts[b - 1]++;
        if (estDue(i)) { duesParBoite[b - 1]++; duesTotal++; }
    }
    const labels = ['Tous les jours', 'Dans 1 jour', 'Dans 3 jours', 'Dans 7 jours', 'Dans 16 jours'];
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
    html += '<div class="boites-resume-txt">📅 ' + duesTotal + " zone(s) à réviser aujourd'hui sur " + total + '</div>';
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
    const total = supportActif.zones.length;
    supportActif.etat = {};
    for (let i = 0; i < total; i++) supportActif.etat[i] = { box: 1, nextDue: todayStr(), indicePerso: '' };
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

/* ---------------- Démarrage ---------------- */

(async function demarrer() {
    supports = await chargerSupports();
    afficherAccueil();
    afficherBanniereEcranAccueilSiBesoin();

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('service-worker.js').catch(() => { /* mode hors-ligne indisponible, l'app reste utilisable en ligne */ });
        });
    }
})();
