// AutoTelemetry — Console OBD (incrément 1 : liaison brute).
// Connecte l'OBDLink CX (ou un transport simulé), envoie des commandes ELM327 et affiche
// les réponses brutes. Mise à jour automatique via le service worker (voir sw.js).
import { WebBluetoothTransport, FakeTransport } from './obd/transport.js';
import { reassembleIsoTp, decode0101, decode0105, decodeOdometer, decodeTpms } from './obd/decoder.js';
import { buildSample, buildReplayJsonl } from './replay.js';

const BUILD = 'v18';
const REC_INTERVAL_MS = 700; // pause entre deux interrogations pendant l'enregistrement
const ODO_EVERY = 20; // interroge odomètre + pneus 1 cycle sur 20 (changent lentement)

// Séquences de commandes (envoyées d'un coup pour capturer vite avant endormissement).
// Ordre important : ATZ réactive l'écho, donc ATE0 vient APRÈS. (voir analyse des trames réelles)
const SEQUENCES = {
  init: ['ATZ', 'ATE0', 'ATL0', 'ATH1', 'ATSP6'],
  // Snapshot batterie Ioniq 5 : init + en-tête BMS (7E4) + tous les blocs 2101..2106
  // (2101 = principal ; 2102/2103/2104 = tensions cellules ; 2105 = SOH/SOC ; 2106 = énergie cumulée…).
  snapshot: ['ATZ', 'ATE0', 'ATL0', 'ATH1', 'ATSP6', 'ATSH7E4',
    '220101', '220102', '220103', '220104', '220105', '220106',
    'ATSH7C6', '22B002',   // odomètre (combiné d'instruments)
    'ATSH7A0', '22C00B',   // pression/température des 4 pneus (TPMS)
    'ATSH7B3', '220100',   // température extérieure + vitesse (à décoder)
    'ATSH7DF', '03'],      // codes défaut (DTC, mode 03 en diffusion)
};

// --- Service worker (mise à jour automatique) ---
if ('serviceWorker' in navigator) {
  // updateViaCache: 'none' -> le navigateur ne sert jamais sw.js depuis le cache HTTP
  // lors de la vérification de mise à jour (important sur GitHub Pages, cache 10 min).
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

// --- Éléments ---
const $ = (id) => document.getElementById(id);
$('build').textContent = BUILD;
const dot = $('dot');
const statusEl = $('status');
const devNameEl = $('devName');
const btnConnect = $('btnConnect');
const btnSimulate = $('btnSimulate');
const btnDisconnect = $('btnDisconnect');
const cmdCard = $('cmdCard');
const cmdInput = $('cmdInput');
const logEl = $('log');
const decodeCard = $('decodeCard');
const decodeBody = $('decodeBody');
const recCard = $('recCard');

let transport = null;

// --- Enregistrement ---
let recording = false;
let recSamples = [];
let recMeta = null;
let recStart = 0;
let recTick = 0;
let lastOdometerKm = null;
let lastTpms = null;
let wakeLock = null;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Garde l'écran allumé pendant l'enregistrement (sinon la veille couperait la capture).
async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
}

// --- Journal ---
function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function log(kind, msg) {
  const line = document.createElement('div');
  line.className = `line ${kind}`;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `${now()} `;
  const m = document.createElement('span');
  m.className = 'm';
  const prefix = kind === 'out' ? '»> ' : kind === 'in' ? '<« ' : kind === 'err' ? '!! ' : '·· ';
  m.textContent = prefix + msg;
  line.append(t, m);
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// --- État UI ---
function setStatus(state, text) {
  dot.className = 'dot' + (state ? ' ' + state : '');
  statusEl.textContent = text;
}
function setConnectedUI(connected) {
  cmdCard.hidden = !connected;
  recCard.hidden = !connected;
  btnDisconnect.hidden = !connected;
  btnConnect.disabled = connected;
  btnSimulate.disabled = connected;
  devNameEl.textContent = connected && transport ? transport.label : '';
}

// --- Connexion ---
async function connect(kind) {
  transport = kind === 'fake' ? new FakeTransport() : new WebBluetoothTransport();
  setStatus('wait', kind === 'fake' ? 'Simulation…' : 'Connexion…');
  log('info', kind === 'fake' ? 'Démarrage du mode simulation' : 'Ouverture du sélecteur Bluetooth…');
  try {
    transport.onDisconnect?.(() => {
      recording = false;
      releaseWakeLock();
      updateRecUI();
      if (recSamples.length) $('recExport').hidden = false;
      setStatus('err', 'Déconnecté');
      setConnectedUI(false);
      log('err', 'Liaison Bluetooth perdue');
    });
    await transport.connect();
    setStatus('on', 'Connecté');
    setConnectedUI(true);
    log('info', `Connecté à ${transport.label}`);
  } catch (err) {
    transport = null;
    setStatus('err', 'Échec');
    setConnectedUI(false);
    log('err', err?.message || String(err));
    if (err?.name === 'NotFoundError') {
      log('info', "Si le CX n'apparaît pas : Localisation activée, voiture réveillée, aucune autre app connectée au CX.");
    }
  }
}

async function disconnect() {
  try { await transport?.disconnect(); } catch {}
  transport = null;
  setStatus('', 'Déconnecté');
  setConnectedUI(false);
  log('info', 'Déconnecté');
}

// --- Commandes ---
async function send(cmd) {
  const c = (cmd ?? '').trim();
  if (!c) return;
  if (!transport?.connected) { log('err', 'Non connecté'); return; }
  log('out', c);
  try {
    const resp = await transport.sendCommand(c);
    log('in', resp || '(réponse vide)');
  } catch (err) {
    log('err', err?.message || String(err));
  }
}

// Envoie une séquence de commandes à la suite (attend chaque réponse).
async function runSequence(name) {
  const cmds = SEQUENCES[name];
  if (!cmds) return;
  if (!transport?.connected) { log('err', 'Non connecté'); return; }
  log('info', `Séquence « ${name} » (${cmds.length} commandes)…`);
  const results = {};
  for (const c of cmds) {
    log('out', c);
    try {
      const resp = await transport.sendCommand(c);
      log('in', resp || '(réponse vide)');
      results[c.trim().toUpperCase()] = resp;
    } catch (err) {
      log('err', err?.message || String(err));
      break; // on stoppe la séquence si une commande échoue (ex. liaison perdue)
    }
  }
  log('info', `Séquence « ${name} » terminée`);
  showDecode(results);
}

// Remplit le panneau « Décodage » à partir des décodages + extras (odomètre, pneus).
function renderDecode(d1, d5, extra = {}) {
  if (!d1 && !d5 && extra.odometerKm == null && !extra.tpms) return;
  const rows = [];
  if (d5) {
    rows.push(['SOC affiché', `${d5.socDisplayPct.toFixed(1)} %`]);
    rows.push(['SOH', `${d5.sohPct.toFixed(1)} %`]);
  }
  if (d1) {
    if (d1.socBmsPct != null) rows.push(['SOC BMS', `${d1.socBmsPct.toFixed(1)} %`]);
    rows.push(['Tension pack', `${d1.voltageV.toFixed(1)} V`]);
    rows.push(['Courant', `${d1.currentA.toFixed(1)} A`]);
    rows.push(['Puissance', `${d1.powerKw.toFixed(2)} kW`]);
    if (d1.cellVMax != null) {
      rows.push(['Cellules', `${d1.cellVMin.toFixed(2)}–${d1.cellVMax.toFixed(2)} V (Δ ${d1.cellDeltaMv} mV)`]);
    }
    rows.push(['Température batterie', `${d1.tempMinC}–${d1.tempMaxC} °C`]);
    if (d1.aux12vV != null) rows.push(['Batterie 12 V', `${d1.aux12vV.toFixed(1)} V`]);
    if (d1.energyChargedKwh != null) {
      rows.push(['Énergie cumulée', `↓ ${d1.energyChargedKwh.toFixed(1)} kWh · ↑ ${d1.energyDischargedKwh.toFixed(1)} kWh`]);
    }
  }
  if (extra.tpms) {
    const t = extra.tpms;
    rows.push(['Pneus (bar)', `AV ${t.fl.bar}/${t.fr.bar} · AR ${t.bl.bar}/${t.br.bar}`]);
  }
  if (extra.odometerKm != null) rows.push(['Odomètre', `${extra.odometerKm.toLocaleString('fr-FR')} km`]);
  decodeBody.innerHTML = rows
    .map(([k, v]) => `<div><span style="color:var(--muted)">${k}</span> : <b>${v}</b></div>`)
    .join('');
  decodeCard.hidden = false;
}

// Décode les réponses d'une séquence et remplit le panneau.
function showDecode(results) {
  const d1 = results['220101'] ? decode0101(reassembleIsoTp(results['220101'])) : null;
  const d5 = results['220105'] ? decode0105(reassembleIsoTp(results['220105'])) : null;
  const odo = results['22B002'] ? decodeOdometer(reassembleIsoTp(results['22B002'])) : null;
  const tpms = results['22C00B'] ? decodeTpms(reassembleIsoTp(results['22C00B'])) : null;
  renderDecode(d1, d5, { odometerKm: odo, tpms });
}

// --- Enregistrement d'une session Replay ---
async function toggleRecord() {
  if (recording) { recording = false; releaseWakeLock(); updateRecUI(); return; }
  if (!transport?.connected) { log('err', 'Non connecté'); return; }
  log('info', "Initialisation de l'enregistrement…");
  try {
    for (const c of [...SEQUENCES.init, 'ATSH7E4']) await transport.sendCommand(c);
  } catch (err) {
    log('err', `Init échouée : ${err?.message || err}`);
    return;
  }
  recSamples = [];
  recTick = 0;
  lastOdometerKm = null;
  lastTpms = null;
  recMeta = { sessionId: crypto.randomUUID(), vehicleId: 'ioniq5', kind: 'trip' };
  recStart = Date.now();
  recording = true;
  $('recExport').hidden = true;
  acquireWakeLock();
  log('info', 'Enregistrement démarré');
  updateRecUI();
  recordLoop();
}

async function recordLoop() {
  while (recording && transport?.connected) {
    try {
      // Signaux lents (odomètre, pneus) : périodiques. On bascule l'en-tête puis retour au BMS.
      if (recTick % ODO_EVERY === 0) {
        try {
          await transport.sendCommand('ATSH7C6');
          const km = decodeOdometer(reassembleIsoTp(await transport.sendCommand('22B002')));
          if (km != null) lastOdometerKm = km;
          await transport.sendCommand('ATSH7A0');
          const tp = decodeTpms(reassembleIsoTp(await transport.sendCommand('22C00B')));
          if (tp != null) lastTpms = tp;
        } catch { /* signaux lents optionnels */ }
        await transport.sendCommand('ATSH7E4'); // retour au BMS (hors try : échec => arrêt propre)
      }
      const r1 = await transport.sendCommand('220101');
      const r5 = await transport.sendCommand('220105');
      const d1 = decode0101(reassembleIsoTp(r1));
      const d5 = decode0105(reassembleIsoTp(r5));
      const extra = { odometerKm: lastOdometerKm, tpms: lastTpms };
      recSamples.push(buildSample(new Date().toISOString(), d1, d5, extra));
      renderDecode(d1, d5, extra);
      updateRecUI();
      recTick++;
    } catch (err) {
      log('err', `Enregistrement interrompu : ${err?.message || err}`);
      recording = false;
      break;
    }
    await delay(REC_INTERVAL_MS);
  }
  releaseWakeLock();
  updateRecUI();
  if (recSamples.length) {
    $('recExport').hidden = false;
    log('info', `Enregistrement arrêté : ${recSamples.length} échantillons`);
  }
}

function updateRecUI() {
  const btn = $('btnRecord');
  btn.textContent = recording ? '■ Arrêter' : '● Enregistrer';
  btn.classList.toggle('primary', !recording);
  // Pendant l'enregistrement, on verrouille les commandes manuelles (conflit de canal).
  document.querySelectorAll('#cmdCard button, #cmdCard input, #btnDisconnect')
    .forEach((el) => { el.disabled = recording; });
  const secs = recStart ? Math.round((Date.now() - recStart) / 1000) : 0;
  const p = (n) => String(n).padStart(2, '0');
  $('recStatus').textContent = (recording || recSamples.length)
    ? `${recording ? '● ' : ''}${recSamples.length} échantillons · ${p(Math.floor(secs / 60))}:${p(secs % 60)}`
    : '';
}

function recFilename() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `replay_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jsonl`;
}

function downloadReplay() {
  const blob = new Blob([buildReplayJsonl(recMeta, recSamples)], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = recFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log('info', `Fichier ${recFilename()} généré (${recSamples.length} échantillons)`);
}

async function shareReplay() {
  const text = buildReplayJsonl(recMeta, recSamples);
  const file = new File([text], recFilename(), { type: 'application/x-ndjson' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: file.name });
    } else if (navigator.share) {
      await navigator.share({ title: file.name, text });
    } else {
      downloadReplay();
    }
  } catch { /* partage annulé */ }
}

async function copyLog() {
  try {
    await navigator.clipboard.writeText(logEl.innerText);
    log('info', 'Journal copié dans le presse-papiers');
  } catch {
    log('err', 'Copie impossible (autorise le presse-papiers)');
  }
}

// Partage le journal via le sélecteur Android (WhatsApp, Gmail, Keep, Drive…).
async function shareLog() {
  const text = logEl.innerText;
  if (navigator.share) {
    try { await navigator.share({ title: 'AutoTelemetry — journal OBD', text }); }
    catch { /* partage annulé par l'utilisateur */ }
  } else {
    await copyLog();
    log('info', 'Partage non supporté ici — journal copié à la place');
  }
}

// État Bluetooth (compatibilité navigateur + adaptateur disponible).
async function refreshBtStatus() {
  const dotEl = $('btDot');
  const txtEl = $('btStatus');
  if (!('bluetooth' in navigator)) {
    dotEl.className = 'dot err';
    txtEl.textContent = 'Navigateur non compatible Web Bluetooth (utilise Chrome sur Android)';
    return;
  }
  let available = true;
  try { available = await navigator.bluetooth.getAvailability(); } catch {}
  dotEl.className = 'dot ' + (available ? 'on' : 'err');
  txtEl.textContent = available ? 'Bluetooth : disponible' : 'Bluetooth : indisponible (active-le)';
}

// --- Événements ---
btnConnect.addEventListener('click', () => connect('ble'));
btnSimulate.addEventListener('click', () => connect('fake'));
btnDisconnect.addEventListener('click', disconnect);
$('btnSend').addEventListener('click', () => { send(cmdInput.value); cmdInput.value = ''; });
cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { send(cmdInput.value); cmdInput.value = ''; }
});
document.querySelectorAll('.presets button').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.seq) runSequence(b.dataset.seq);
    else send(b.dataset.cmd);
  });
});
$('btnShare').addEventListener('click', shareLog);
$('btnCopy').addEventListener('click', copyLog);
$('btnClear').addEventListener('click', () => { logEl.innerHTML = ''; });
$('btnRecord').addEventListener('click', toggleRecord);
$('btnDownload').addEventListener('click', downloadReplay);
$('btnShareFile').addEventListener('click', shareReplay);
// Le Wake Lock est relâché quand l'onglet passe en arrière-plan : on le reprend au retour.
document.addEventListener('visibilitychange', () => {
  if (recording && document.visibilityState === 'visible' && !wakeLock) acquireWakeLock();
});

// État initial
setStatus('', 'Déconnecté');
setConnectedUI(false);
refreshBtStatus();
if ('bluetooth' in navigator && navigator.bluetooth.addEventListener) {
  navigator.bluetooth.addEventListener('availabilitychanged', refreshBtStatus);
}
log('info', `Console prête (build ${BUILD}). Connecte l'OBDLink CX, ou utilise le mode simulation.`);
