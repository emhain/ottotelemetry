// AutoTelemetry — Console OBD (incrément 1 : liaison brute).
// Connecte l'OBDLink CX (ou un transport simulé), envoie des commandes ELM327 et affiche
// les réponses brutes. Mise à jour automatique via le service worker (voir sw.js).
import { WebBluetoothTransport, FakeTransport } from './obd/transport.js';
import { reassembleIsoTp, decode0101, decode0105 } from './obd/decoder.js';
import { buildSample, buildReplayJsonl } from './replay.js';

const BUILD = 'v12';
const REC_INTERVAL_MS = 700; // pause entre deux interrogations pendant l'enregistrement

// Séquences de commandes (envoyées d'un coup pour capturer vite avant endormissement).
// Ordre important : ATZ réactive l'écho, donc ATE0 vient APRÈS. (voir analyse des trames réelles)
const SEQUENCES = {
  init: ['ATZ', 'ATE0', 'ATL0', 'ATH1', 'ATSP0'],
  // Snapshot batterie Ioniq 5 : init + en-tête BMS (7E4) + blocs 220101 / 220105.
  snapshot: ['ATZ', 'ATE0', 'ATL0', 'ATH1', 'ATSP0', 'ATSH7E4', '220101', '220105'],
};

// --- Service worker (mise à jour automatique) ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
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

// Remplit le panneau « Décodage » à partir des objets décodés d1 (220101) / d5 (220105).
function renderDecode(d1, d5) {
  if (!d1 && !d5) return;
  const rows = [];
  if (d5) {
    rows.push(['SOC affiché', `${d5.socDisplayPct.toFixed(1)} %`]);
    rows.push(['SOH', `${d5.sohPct.toFixed(1)} %`]);
  }
  if (d1) {
    rows.push(['Tension pack', `${d1.voltageV.toFixed(1)} V`]);
    rows.push(['Courant', `${d1.currentA.toFixed(1)} A`]);
    rows.push(['Puissance', `${d1.powerKw.toFixed(2)} kW`]);
    rows.push(['Température batterie', `${d1.tempMinC}–${d1.tempMaxC} °C`]);
  }
  decodeBody.innerHTML = rows
    .map(([k, v]) => `<div><span style="color:var(--muted)">${k}</span> : <b>${v}</b></div>`)
    .join('');
  decodeCard.hidden = false;
}

// Décode les réponses 220101/220105 d'une séquence et remplit le panneau.
function showDecode(results) {
  const d1 = results['220101'] ? decode0101(reassembleIsoTp(results['220101'])) : null;
  const d5 = results['220105'] ? decode0105(reassembleIsoTp(results['220105'])) : null;
  renderDecode(d1, d5);
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
      const r1 = await transport.sendCommand('220101');
      const r5 = await transport.sendCommand('220105');
      const d1 = decode0101(reassembleIsoTp(r1));
      const d5 = decode0105(reassembleIsoTp(r5));
      recSamples.push(buildSample(new Date().toISOString(), d1, d5));
      renderDecode(d1, d5);
      updateRecUI();
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
