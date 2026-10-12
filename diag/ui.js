// Écran « Diagnostic recharge AC » : pilote ChargeDiagnostic et affiche verdict + détails.
// Intégré à la console (index.html, carte #diagCard) ; la liaison BLE reste celle de app.js.
import { ChargeDiagnostic, computeVerdict, didChanges, flattenDtcs, KNOWN_ECUS } from './charge-diag.js';
import { describeDtc, dtcFullCode } from '../obd/uds.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, unit, digits = 1) => (v == null ? '—' : `${Number(v).toFixed(digits)} ${unit}`);
const SAVE_KEY = 'diag.lastReport';

/**
 * @param getTransport () → transport connecté (ou null)
 * @param log          (kind, msg) → journal de la console
 * @param setBusy      (bool) → verrouille le reste de la console pendant une étape
 * @param isBlocked    () → true si la console est occupée ailleurs (enregistrement en cours)
 */
export function initDiagUi({ getTransport, log, setBusy, isBlocked = () => false }) {
  let diag = null;
  let running = false;

  const progress = $('diagProgress');
  const btnA = $('diagStepA');
  const btnB = $('diagStepB');
  const btnC = $('diagStepC');
  const markers = $('diagMarkers');

  function ensureDiag() {
    const t = getTransport();
    if (!t?.connected) throw new Error('Non connecté');
    if (!diag) diag = new ChargeDiagnostic(t, { log, onUpdate: render });
    // Reconnexion après une coupure Bluetooth : on GARDE le rapport en cours (étape C possible).
    else if (diag.t !== t) diag.attach(t);
    return diag;
  }

  // Sauvegarde locale : survit à une coupure Bluetooth, à un rechargement de la page ou à la
  // fermeture de l'onglet. Pendant la surveillance, on sauvegarde au fil de l'eau (tous les 5 relevés).
  let savedSamples = 0;
  function save() {
    if (!diag) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(diag.report));
      savedSamples = diag.report.monitor.samples.length;
    } catch { /* quota / navigation privée */ }
  }
  function autosave() {
    if (diag?.monitoring && diag.report.monitor.samples.length - savedSamples >= 5) save();
  }
  function restore() {
    try {
      const report = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null');
      if (report?.type !== 'charge-diagnostic' || !report.ref) return;
      diag = new ChargeDiagnostic(null, { log, onUpdate: render });
      diag.report = report;
      progress.textContent = `Rapport du ${new Date(report.startedAt).toLocaleString('fr-FR')} restauré.`;
    } catch { /* stockage indisponible ou rapport illisible */ }
  }
  function clearReport() {
    if (diag?.monitoring || running) return;
    if (!confirm('Effacer le rapport de diagnostic de ce téléphone ? (pensez à l\'exporter avant)')) return;
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignoré */ }
    diag = null;
    progress.textContent = '';
    ['diagRefSummary', 'diagLive', 'diagAfterSummary'].forEach((id) => { $(id).textContent = ''; });
    $('diagVerdict').hidden = true;
    onVisibility();
    updateButtons();
  }

  async function runStep(label, fn) {
    if (running) return;
    running = true;
    setBusy(true);
    updateButtons();
    try {
      await fn(ensureDiag());
      progress.textContent = `${label} : terminé.`;
      save();
    } catch (err) {
      progress.textContent = `${label} : échec — ${err?.message || err}`;
      log('err', `Diagnostic : ${err?.message || err}`);
    } finally {
      running = false;
      setBusy(false);
      updateButtons();
      render();
    }
  }

  const stepA = () => runStep('Référence', async (d) => {
    diag = new ChargeDiagnostic(d.t, { log, onUpdate: render }); // nouveau rapport à chaque référence
    log('info', 'Diagnostic — étape A (référence)…');
    await diag.stepReference((msg) => { progress.textContent = msg; });
  });

  async function toggleMonitor() {
    if (diag?.monitoring) { diag.stopMonitor(); return; }
    if (running) return;
    running = true;
    setBusy(true);
    updateButtons();
    progress.textContent = 'Surveillance en cours : branchez le câble puis touchez « Câble branché ».';
    log('info', 'Diagnostic — étape B (surveillance)…');
    try {
      await ensureDiag().runMonitor();
      const why = { auto: 'arrêt automatique', manual: 'arrêtée', disconnected: 'liaison perdue' }[diag.report.monitor.stopReason] ?? 'arrêtée';
      progress.textContent = `Surveillance terminée — ${why} (${diag.report.monitor.samples.length} relevés). Reconnectez si besoin puis lancez l'étape C.`;
    } catch (err) {
      progress.textContent = `Surveillance interrompue — ${err?.message || err}. Rapport conservé : reconnectez puis lancez l'étape C.`;
      log('err', `Diagnostic : ${err?.message || err}`);
    } finally {
      save(); // y compris après une coupure : rien n'est perdu
      running = false;
      setBusy(false);
      updateButtons();
      render();
    }
  }

  const stepC = () => runStep('Relecture des codes', async (d) => {
    log('info', 'Diagnostic — étape C (après la tentative)…');
    await d.stepAfter((msg) => { progress.textContent = msg; });
  });

  function marker(label) {
    if (!diag?.monitoring) return;
    diag.addMarker(label);
    if (label === 'Câble branché') diag.t.simulate?.('plug'); // transport simulé uniquement
  }

  function updateButtons() {
    const mon = !!diag?.monitoring;
    const hasRef = !!diag?.report.ref;
    const connected = !!getTransport()?.connected;
    const blocked = isBlocked() || !connected;
    btnA.disabled = running || blocked;
    btnB.disabled = (blocked && !mon) || !hasRef || (running && !mon);
    btnB.textContent = mon ? '■ Arrêter la surveillance' : 'B · Surveiller le branchement';
    btnB.classList.toggle('primary', !mon && hasRef && !diag?.report.monitor.samples.length);
    btnC.disabled = running || blocked || !hasRef;
    markers.hidden = !mon;
    $('diagExport').hidden = !hasRef;
  }

  // --- Rendu ---
  function render() {
    updateButtons();
    autosave();
    if (!diag) return;
    const r = diag.report;
    const ref = r.ref;

    // Résumé de l'étape A
    $('diagRefSummary').innerHTML = ref ? [
      `${r.ecus.length} calculateur(s) trouvé(s)`,
      `12 V ${fmt(ref.bms?.aux12vV, 'V')}`,
      `SOC ${fmt(ref.bms?.socDisplayPct, '%')}`,
      `${flattenDtcs(ref).length} code(s) constructeur`,
    ].map(esc).join(' · ') : '';

    // Surveillance en direct
    const s = r.monitor.samples;
    const last = s[s.length - 1];
    const left = diag.monitoring ? Math.max(0, Math.round(diag.monitorRemainingMs() / 1000)) : null;
    $('diagLive').innerHTML = s.length ? esc([
      `${s.length} relevés`,
      `courant ${fmt(last?.bms?.currentA, 'A')}`,
      `12 V ${fmt(last?.bms?.aux12vV, 'V')}`,
      r.monitor.markers.length ? `repères : ${r.monitor.markers.map((m) => m.label).join(', ')}` : 'aucun repère',
      ...(left != null ? [`arrêt auto dans ${Math.floor(left / 60)} min ${String(left % 60).padStart(2, '0')} s`] : []),
    ].join(' · ')) : '';

    $('diagAfterSummary').textContent = r.after ? `Relu à ${new Date(r.after.t).toLocaleTimeString('fr-FR')}` : '';

    // Verdict
    const v = computeVerdict(r);
    $('diagVerdict').hidden = !ref;
    $('diagVerdictList').innerHTML = v.items.map((i) => `
      <li class="v-${i.level}"><span class="dot"></span><div><b>${esc(i.title)}</b><br><span class="sub">${esc(i.detail)}</span></div></li>`).join('');

    // Calculateurs
    const reading = r.after ?? ref;
    $('diagEcus').innerHTML = r.ecus.map((e) => {
      const rd = reading?.byEcu?.[e.header] ?? e;
      const codes = rd.status === 'ok'
        ? (rd.dtcs.length ? rd.dtcs.map((d) => `${dtcFullCode(d)} (${d.statusText})${describeDtc(d) ? ` — ${describeDtc(d).text}` : ''}`).join(', ') : 'aucun code')
        : (rd.nrcText ?? rd.status);
      const known = KNOWN_ECUS[e.header];
      return `<tr><td>${esc(e.header)}</td><td>${esc(e.name)}${known && !known.confirmed ? ' <span class="sub">(à confirmer)</span>' : ''}</td><td>${esc(codes)}</td></tr>`;
    }).join('') || '<tr><td colspan="3" class="sub">—</td></tr>';

    // Octets qui ont bougé
    const ch = didChanges(r.monitor).slice(0, 40);
    $('diagChanges').innerHTML = ch.length ? ch.map((c) => `<tr><td>${esc(c.key)}</td><td>b[${c.index}]</td><td>${c.before ?? '—'} → ${c.after ?? '—'}</td><td>${c.min}–${c.max}</td></tr>`).join('')
      : '<tr><td colspan="4" class="sub">Aucun octet n\'a varié (ou pas encore de surveillance).</td></tr>';
  }

  // --- Export ---
  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function reportText() {
    return JSON.stringify({ ...diag.report, verdict: computeVerdict(diag.report) }, null, 1);
  }
  function summaryText() {
    const v = computeVerdict(diag.report);
    return ['Diagnostic recharge AC — Ioniq 5', new Date().toLocaleString('fr-FR'), '',
      ...v.items.map((i) => `[${i.level.toUpperCase()}] ${i.title}\n  ${i.detail}`)].join('\n');
  }
  function download() {
    const name = `diag_charge_${stamp()}.json`;
    const url = URL.createObjectURL(new Blob([reportText()], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log('info', `Rapport ${name} généré`);
  }
  async function share() {
    const name = `diag_charge_${stamp()}.json`;
    const file = new File([reportText()], name, { type: 'application/json' });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: name });
      else download();
    } catch { /* partage annulé */ }
  }
  async function copySummary() {
    try { await navigator.clipboard.writeText(summaryText()); log('info', 'Résumé du diagnostic copié'); }
    catch { log('err', 'Copie impossible (autorise le presse-papiers)'); }
  }

  btnA.addEventListener('click', stepA);
  btnB.addEventListener('click', toggleMonitor);
  btnC.addEventListener('click', stepC);
  markers.querySelectorAll('button[data-marker]').forEach((b) => b.addEventListener('click', () => marker(b.dataset.marker)));
  $('diagMarkerOther').addEventListener('click', () => {
    const label = prompt('Repère (ex. « voyants verts », « clac du verrou »)');
    if (label) marker(label.slice(0, 60));
  });
  $('diagDownload').addEventListener('click', download);
  $('diagShare').addEventListener('click', share);
  $('diagCopy').addEventListener('click', copySummary);
  $('diagClear').addEventListener('click', clearReport);

  // La carte reste visible hors connexion dès qu'un rapport existe (consultation / export).
  function onVisibility() {
    $('diagCard').hidden = !getTransport()?.connected && !diag?.report.ref;
  }

  restore();
  updateButtons();
  render();
  return {
    /** Liaison perdue : la surveillance s'arrête d'elle-même ; on garde et on sauvegarde le rapport. */
    onDisconnect() { diag?.stopMonitor(); save(); updateButtons(); },
    get busy() { return running; },
    refresh() { updateButtons(); onVisibility(); },
  };
}
