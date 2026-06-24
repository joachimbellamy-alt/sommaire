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

/* ---------------- Stockage ---------------- */

function chargerSupports() {
    try {
        const raw = localStorage.getItem('memo_supports_v2');
        return raw ? JSON.parse(raw) : [];
    } catch (e) {
        return [];
    }
}

function sauvegarderSupports() {
    try {
        localStorage.setItem('memo_supports_v2', JSON.stringify(supports));
    } catch (e) {
        alert("Espace de stockage insuffisant sur cet appareil. Essaie de supprimer un ancien support ou de réduire le nombre de photos.");
    }
}

function genererId() {
    return 'sup_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------------- Navigation entre vues ---------------- */

function afficherVue(nom) {
    document.getElementById('vueAccueil').style.display = nom === 'accueil' ? '' : 'none';
    document.getElementById('vueEdition').style.display = nom === 'edition' ? '' : 'none';
    document.getElementById('vueRevision').style.display = nom === 'revision' ? '' : 'none';
    document.getElementById('btnRetour').style.display = nom === 'accueil' ? 'none' : '';
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

function afficherAccueil() {
    afficherVue('accueil');
    const liste = document.getElementById('listeSupports');
    if (supports.length === 0) {
        liste.innerHTML = '<div class="vide">Tu n\u2019as pas encore de support. Crée-en un pour commencer à réviser !</div>';
        return;
    }
    liste.innerHTML = supports.slice().reverse().map(s => `
        <div class="carte-support" data-id="${s.id}">
            <img src="${s.image || ''}" alt="">
            <div class="infos">
                <div class="nom"></div>
                <div class="meta"></div>
            </div>
            <button class="icon-btn danger" data-suppr="${s.id}" style="flex-shrink:0;">🗑</button>
            <div class="chevron">›</div>
        </div>
    `).join('');
    liste.querySelectorAll('.carte-support').forEach(carte => {
        const id = carte.getAttribute('data-id');
        const s = supports.find(x => x.id === id);
        carte.querySelector('.nom').textContent = s.nom;
        const n = s.zones.length;
        carte.querySelector('.meta').textContent = n + ' zone' + (n === 1 ? '' : 's') + ' à réviser';
        carte.addEventListener('click', (ev) => {
            if (ev.target.closest('[data-suppr]')) return;
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
}

function creerNouveauSupport() {
    const nom = prompt('Nom de ce support (ex : Leçon sur les fractions) :', '');
    if (nom === null) return;
    const support = {
        id: genererId(),
        nom: nom.trim() || 'Sans titre',
        image: '',
        zones: [],
        etat: {},
        mode: 'simple',
        creeLe: Date.now()
    };
    supports.push(support);
    sauvegarderSupports();
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
        redimensionnerEtStocker(ev.target.result, (dataUrlFinal) => {
            supportActif.image = dataUrlFinal;
            supportActif.zones = [];
            sauvegarderSupports();
            chargerCanvasEdition();
        });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
};

function redimensionnerEtStocker(dataUrlOriginal, callback) {
    const img = new Image();
    img.onload = () => {
        const maxW = 1280;
        let w = img.naturalWidth, h = img.naturalHeight;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        callback(c.toDataURL('image/jpeg', 0.82));
    };
    img.src = dataUrlOriginal;
}

function appliquerZoom() {
    const img = canvasEl.querySelector('img');
    if (!img || !imgNaturalW) return;
    img.style.width = (imgNaturalW * zoomLevel) + 'px';
    img.style.height = 'auto';
    document.getElementById('zoomLabel').textContent = Math.round(zoomLevel * 100) + '%';
    redessinerZonesEdition();
}
function zoomIn() { if (!imgNaturalW) return; zoomLevel = Math.min(3, zoomLevel + 0.15); appliquerZoom(); }
function zoomOut() { if (!imgNaturalW) return; zoomLevel = Math.max(0.15, zoomLevel - 0.15); appliquerZoom(); }
function zoomReset() {
    if (!imgNaturalW) return;
    const maxL = Math.min(window.innerWidth * 0.9, 700);
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

function handleStart(e) {
    if (!canvasEl.querySelector('img')) return;
    if (e.type === 'touchstart') {
        e.preventDefault();
        if (e.touches.length >= 2) return; // on ignore le multi-doigts : zoom uniquement via les boutons
    }
    const p = posRelative(e);
    startX = p.x; startY = p.y; drawing = true;
    currentRect = document.createElement('div');
    currentRect.className = 'rect';
    currentRect.style.left = startX + 'px';
    currentRect.style.top = startY + 'px';
    canvasEl.appendChild(currentRect);
}

function handleMove(e) {
    if (e.type === 'touchmove' && e.touches.length >= 2) { e.preventDefault(); return; }
    if (!drawing || !currentRect) return;
    if (e.type === 'touchmove') e.preventDefault();
    const p = posRelative(e);
    const w = p.x - startX, h = p.y - startY;
    currentRect.style.left = (w < 0 ? p.x : startX) + 'px';
    currentRect.style.top = (h < 0 ? p.y : startY) + 'px';
    currentRect.style.width = Math.abs(w) + 'px';
    currentRect.style.height = Math.abs(h) + 'px';
}

function handleEnd(e) {
    if (!drawing || !currentRect) { drawing = false; return; }
    const p = posRelative(e);
    const w = p.x - startX, h = p.y - startY;
    const x = w < 0 ? p.x : startX, y = h < 0 ? p.y : startY;
    const width = Math.abs(w), height = Math.abs(h);
    drawing = false;

    if (width <= CLICK_THRESHOLD && height <= CLICK_THRESHOLD) {
        currentRect.remove(); currentRect = null;
        supprimerZoneAuPoint((x / p.canvasW) * 100, (y / p.canvasH) * 100);
        return;
    }

    supportActif.zones.push({
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
        const div = document.createElement('div');
        div.className = 'rect';
        div.style.left = (decalX + z.xPct / 100 * rect.width) + 'px';
        div.style.top = (decalY + z.yPct / 100 * rect.height) + 'px';
        div.style.width = (z.wPct / 100 * rect.width) + 'px';
        div.style.height = (z.hPct / 100 * rect.height) + 'px';
        const label = document.createElement('span');
        label.className = 'rect-label';
        label.textContent = i + 1;
        div.appendChild(label);
        canvasEl.appendChild(div);
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

function ouvrirModalIndices() {
    if (!supportActif || supportActif.zones.length === 0) { alert("Trace d'abord au moins une zone."); return; }
    const liste = document.getElementById('listeIndices');
    liste.innerHTML = supportActif.zones.map((z, i) => `
        <div style="margin-bottom:10px;">
            <label style="font-size:13px; font-weight:bold;">Zone ${i + 1}</label>
            <input type="text" class="indice-input-texte" data-idx="${i}" value="${echapperHtml(z.indice || '')}" placeholder="Ex : verbe, commence par É...">
        </div>
    `).join('');
    document.getElementById('modalIndices').classList.add('ouverte');
}
function fermerModalIndices() { document.getElementById('modalIndices').classList.remove('ouverte'); }
function enregistrerIndices() {
    document.querySelectorAll('.indice-input-texte').forEach(inp => {
        const i = parseInt(inp.getAttribute('data-idx'), 10);
        supportActif.zones[i].indice = inp.value.trim();
    });
    sauvegarderSupports();
    fermerModalIndices();
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

supports = chargerSupports();
afficherAccueil();

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').catch(() => { /* mode hors-ligne indisponible, l'app reste utilisable en ligne */ });
    });
}
